// src/sync-engine.js — 同步计划生成与执行（纯逻辑层，便于测试）
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, utimesSync } from 'fs';
import { dirname, join } from 'path';

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 计算 Buffer 的 SHA-256 hex
 */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 判断两个文件条目的 mtime 是否在容差范围内相等
 */
function mtimeEqual(a, b, toleranceMs) {
  return Math.abs(a.mtime - b.mtime) <= toleranceMs;
}

/**
 * 归一化文件集合：数组 [{rel,...}] → 对象 { [rel]: {...} }
 */
function toFileMap(files) {
  if (!files) return {};
  if (Array.isArray(files)) {
    const map = {};
    for (const f of files) { if (f?.rel) map[f.rel] = f; }
    return map;
  }
  return files;
}

// ─── buildPlan ────────────────────────────────────────────────────────────────

/**
 * 纯函数：对比本地和远端文件集合，生成同步计划
 *
 * @param {{
 *   localFiles:  Object<string, { mtime, size, sha256? }>,
 *   remoteFiles: Object<string, { mtime, size, sha256? }>,
 *   config:      object  — 包含 sync.compare / sync.time_tolerance_seconds / conflict.policy
 * }} params
 *
 * @returns {{
 *   to_upload:   string[],
 *   to_download: string[],
 *   conflicts:   Array<{ rel, local, remote }>,
 *   unchanged:   string[]
 * }}
 */
export function buildPlan({ localFiles, remoteFiles, config }) {
  // 兼容两种输入：数组 [{rel,mtime,size}] 或对象 { [rel]: {mtime,size} }
  localFiles  = toFileMap(localFiles);
  remoteFiles = toFileMap(remoteFiles);
  const compare   = config?.sync?.compare ?? 'mtime';
  const toleranceMs = (config?.sync?.time_tolerance_seconds ?? 2) * 1000;

  const to_upload   = [];
  const to_download = [];
  const conflicts   = [];
  const unchanged   = [];

  // 合并所有 rel 键
  const allRels = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)]);

  for (const rel of allRels) {
    const local  = localFiles[rel]  ?? null;
    const remote = remoteFiles[rel] ?? null;

    // 远端缺失 → 上传
    if (!remote) { to_upload.push(rel); continue; }
    // 本地缺失 → 下载
    if (!local)  { to_download.push(rel); continue; }

    // 两端都有，需要比较
    const decision = compareFiles(local, remote, { compare, toleranceMs });

    if (decision === 'equal')   { unchanged.push(rel); }
    else if (decision === 'upload')   { to_upload.push(rel); }
    else if (decision === 'download') { to_download.push(rel); }
    else { conflicts.push({ rel, local, remote }); }
  }

  return { to_upload, to_download, conflicts, unchanged };
}

/**
 * 比较两个文件条目
 * @returns {'equal'|'upload'|'download'|'conflict'}
 */
function compareFiles(local, remote, { compare, toleranceMs }) {
  // 大小相同且 mtime 相差在容差内：视为相同（mtime 模式）
  if (local.size === remote.size && mtimeEqual(local, remote, toleranceMs)) {
    if (compare === 'mtime') return 'equal';
    // mtime_hash_fallback：mtime 接近时比较 hash
    if (compare === 'mtime_hash_fallback') {
      if (local.sha256 && remote.sha256) {
        return local.sha256 === remote.sha256 ? 'equal' : 'conflict';
      }
      // 缺少 hash 时按 mtime 逻辑处理
      return 'equal';
    }
  }

  // 大小不同或 mtime 超出容差：取更新的一方
  if (local.mtime > remote.mtime + toleranceMs) return 'upload';
  if (remote.mtime > local.mtime + toleranceMs) return 'download';

  // mtime 接近但大小不同：冲突
  return 'conflict';
}

// ─── applyPlan ────────────────────────────────────────────────────────────────

/**
 * 执行同步计划
 *
 * @param {{
 *   plan:       ReturnType<buildPlan>,
 *   config:     object,
 *   localBase:  string,   — 本地根目录绝对路径
 *   remoteBase: string,   — 远端根路径（WebDAV）
 *   webdavClient: object, — src/webdav-client.js 导出的 client 实例
 *   onProgress: (info: { file, action, n, total }) => void
 * }} params
 *
 * @returns {Promise<{ uploaded, downloaded, skipped, errors }>}
 */
export async function applyPlan({
  plan,
  config,
  localBase,
  remoteBase,
  webdavClient,
  davClient,            // 别名参数，兼容调用方
  onProgress = () => {},
}) {
  webdavClient = webdavClient ?? davClient;
  const conflictPolicy = config?.conflict?.policy ?? 'manual_abort';
  const backupEnabled  = config?.backup?.enabled ?? false;

  let uploaded = 0, downloaded = 0, skipped = 0;
  const errors = [];

  // 解析冲突
  let effectivePlan = { ...plan };
  if (plan.conflicts.length > 0) {
    const resolved = resolveConflicts(plan.conflicts, conflictPolicy);
    effectivePlan = {
      to_upload:   [...plan.to_upload,   ...resolved.to_upload],
      to_download: [...plan.to_download, ...resolved.to_download],
      conflicts:   resolved.remaining,
      unchanged:   plan.unchanged,
    };
  }

  // manual_abort：有未解决冲突则停止
  if (effectivePlan.conflicts.length > 0 && conflictPolicy === 'manual_abort') {
    for (const c of effectivePlan.conflicts) {
      errors.push({ rel: c.rel, reason: 'conflict', detail: c });
    }
    return { uploaded, downloaded, skipped, errors };
  }

  const total =
    effectivePlan.to_upload.length +
    effectivePlan.to_download.length +
    (effectivePlan.conflicts?.length ?? 0);
  let n = 0;

  // 上传
  // 注意：webdavClient 内部已拼接 remote_path 前缀，这里直接传 rel
  for (const rel of effectivePlan.to_upload) {
    n++;
    onProgress({ file: rel, action: 'upload', n, total });
    try {
      const localPath = join(localBase, rel);
      if (backupEnabled) await backupRemote(webdavClient, rel, config);
      const buf = readFileSync(localPath);
      await webdavClient.putFile(rel, buf);
      uploaded++;
    } catch (err) {
      errors.push({ rel, action: 'upload', reason: err.message });
    }
  }

  // 下载
  for (const rel of effectivePlan.to_download) {
    n++;
    onProgress({ file: rel, action: 'download', n, total });
    try {
      const localPath = join(localBase, rel);
      // Read metadata before content so a later remote edit is detected next time.
      const remoteStat = await webdavClient.stat(rel);
      if (!Number.isFinite(remoteStat?.mtime)) {
        throw new Error(`Remote modification time unavailable: ${rel}`);
      }
      const buf = await webdavClient.getFile(rel);
      if (backupEnabled) backupLocal(localPath, config);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, buf);
      const remoteTime = new Date(remoteStat.mtime);
      utimesSync(localPath, remoteTime, remoteTime);
      downloaded++;
    } catch (err) {
      errors.push({ rel, action: 'download', reason: err.message });
    }
  }

  return { uploaded, downloaded, skipped, errors };
}

// ─── 冲突解决 ─────────────────────────────────────────────────────────────────

/**
 * 根据策略把 conflicts 分流到 to_upload / to_download / remaining
 */
function resolveConflicts(conflicts, policy) {
  const to_upload = [], to_download = [], remaining = [];

  for (const c of conflicts) {
    if (policy === 'prefer_local') {
      to_upload.push(c.rel);
    } else if (policy === 'prefer_cloud') {
      to_download.push(c.rel);
    } else if (policy === 'prefer_newer_mtime') {
      if ((c.local?.mtime ?? 0) >= (c.remote?.mtime ?? 0)) {
        to_upload.push(c.rel);
      } else {
        to_download.push(c.rel);
      }
    } else {
      // manual_abort 或未知策略：保留为冲突
      remaining.push(c);
    }
  }

  return { to_upload, to_download, remaining };
}

// ─── 备份辅助 ─────────────────────────────────────────────────────────────────

/**
 * 覆盖前备份本地文件（写入 .bak 副本）
 */
function backupLocal(localPath, _config) {
  if (!existsSync(localPath)) return;
  try {
    copyFileSync(localPath, localPath + '.bak');
  } catch { /* 备份失败不阻断主流程 */ }
}

/**
 * 覆盖前备份远端文件（下载到本地 .bak）
 * TODO: 可改为上传到 backup 目录
 */
async function backupRemote(webdavClient, remotePath, _config) {
  try {
    const buf = await webdavClient.getFile(remotePath);
    if (buf) {
      // 暂不持久化远端备份，仅检查可访问性
    }
  } catch { /* 远端文件可能不存在，忽略 */ }
}

/**
 * 拼接远端路径（避免双斜线）
 */
function joinRemote(base, rel) {
  return base.replace(/\/$/, '') + '/' + rel.replace(/^\//, '');
}

// 别名导出，兼容 buildSyncPlan 命名
export { buildPlan as buildSyncPlan };
