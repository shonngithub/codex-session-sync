// src/webdav-client.js — 封装 webdav npm 包，提供统一的 WebDAV 操作接口
import { createClient } from 'webdav';

/**
 * 创建 WebDAV 客户端实例
 * @param {{ url, username, password, remote_path }} webdavConfig
 * @returns {object} client
 */
export function createWebDAVClient(webdavConfig) {
  const { url, username, password, remote_path = '/codex-sync' } = webdavConfig;

  if (!url) throw new Error('WebDAV url is required');

  // 创建底层 webdav 包客户端
  const raw = createClient(url, {
    username: username || undefined,
    password: password || undefined,
  });

  // 规范化 remote_path：确保以 / 开头、不以 / 结尾
  const baseRemotePath = ('/' + remote_path.replace(/^\//, '')).replace(/\/$/, '') || '/';

  /**
   * 拼接完整远端路径
   * @param {string} rel  相对路径
   */
  function fullPath(rel) {
    const normalized = rel.replace(/\\/g, '/').replace(/^\//, '');
    return baseRemotePath + '/' + normalized;
  }

  return {
    /**
     * 列出远端目录内容（递归）
     * 注意：不用 deep:true（Depth: infinity），许多服务器出于安全默认拒绝（403），
     * 改为逐层 Depth:1 递归，兼容性更好。
     * @param {string} remotePath  相对于 remote_path 的路径，默认为根；
     *                             也接受完整的 remote_path（或其子路径）以避免误传导致路径重复拼接
     * @returns {Promise<Array<{ rel, mtime, size }>>}
     */
    async list(remotePath = '') {
      // remotePath 为空 → 列 baseRemotePath 根目录；
      // remotePath 已是 baseRemotePath 或其子路径 → 直接使用，避免 fullPath() 二次拼接产生重复前缀
      const target = remotePath
        ? (remotePath === baseRemotePath || remotePath.startsWith(baseRemotePath + '/')
            ? remotePath
            : fullPath(remotePath))
        : baseRemotePath;
      const files = [];
      await listRecursive(raw, target, files);
      return files.map(item => ({
        // rel 相对于 baseRemotePath
        rel: item.filename.replace(baseRemotePath, '').replace(/^\//, '').replace(/\\/g, '/'),
        mtime: new Date(item.lastmod).getTime(),
        size: item.size ?? 0,
      }));
    },

    /**
     * 获取远端文件元数据
     * @param {string} remotePath
     * @returns {Promise<{ mtime, size } | null>}
     */
    async stat(remotePath) {
      try {
        const item = await raw.stat(fullPath(remotePath));
        return {
          mtime: new Date(item.lastmod).getTime(),
          size: item.size ?? 0,
        };
      } catch (err) {
        // 文件不存在时返回 null
        if (err?.status === 404 || err?.response?.status === 404) return null;
        throw err;
      }
    },

    /**
     * 下载远端文件，返回 Buffer
     * @param {string} remotePath
     * @returns {Promise<Buffer>}
     */
    async getFile(remotePath) {
      const data = await raw.getFileContents(fullPath(remotePath));
      // webdav v5 返回 Buffer 或 ArrayBuffer
      if (Buffer.isBuffer(data)) return data;
      return Buffer.from(data);
    },

    /**
     * 上传文件到远端
     * @param {string} remotePath
     * @param {Buffer} buffer
     */
    async putFile(remotePath, buffer) {
      const target = fullPath(remotePath);
      // 确保父目录存在
      await ensureRemoteDir(raw, dirOf(target));
      await raw.putFileContents(target, buffer, { overwrite: true });
    },

    /**
     * 创建远端目录（包括中间目录）
     * @param {string} remotePath
     */
    async mkdir(remotePath) {
      await ensureRemoteDir(raw, fullPath(remotePath));
    },

    /**
     * 测试连通性
     * 远端目录不存在（404）视为连接成功——首次同步时会自动创建
     * @returns {Promise<{ ok: boolean, latency_ms: number, error?: string }>}
     */
    async testConnection() {
      const start = Date.now();
      try {
        await raw.getDirectoryContents(baseRemotePath);
        return { ok: true, latency_ms: Date.now() - start };
      } catch (err) {
        const status = err?.status ?? err?.response?.status;
        if (status === 404) return { ok: true, latency_ms: Date.now() - start };
        return { ok: false, latency_ms: Date.now() - start, error: err.message };
      }
    },
  };
}

// ─── 内部辅助 ─────────────────────────────────────────────────────────────────

/**
 * 逐层递归列出目录下所有文件（Depth: 1 PROPFIND）
 * 目录不存在（404）时静默返回
 */
async function listRecursive(rawClient, dirPath, acc) {
  let items;
  try {
    items = await rawClient.getDirectoryContents(dirPath);
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if (status === 404) return;
    throw err;
  }
  for (const item of items) {
    if (item.type === 'file') acc.push(item);
    else if (item.type === 'directory') await listRecursive(rawClient, item.filename, acc);
  }
}

/**
 * 递归确保远端目录存在（逐级创建）
 */
async function ensureRemoteDir(rawClient, dirPath) {
  if (!dirPath || dirPath === '/') return;
  try {
    await rawClient.createDirectory(dirPath, { recursive: true });
  } catch (err) {
    // 目录已存在（405 / 409）时忽略
    const status = err?.status ?? err?.response?.status;
    if (status !== 405 && status !== 409 && status !== 301) throw err;
  }
}

/**
 * 取路径的父目录部分
 */
function dirOf(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/') || '/';
}
