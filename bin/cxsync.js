#!/usr/bin/env node
// bin/cxsync.js — CLI entry point
import { Command } from 'commander';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { loadConfig, writeExampleConfig, getDefaultConfigPath } from '../src/config.js';
import { Logger } from '../src/logger.js';

const program = new Command();

program
  .name('cxsync')
  .description('Codex session sync — local-first backup and WebDAV sync with Web GUI')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to config.yml')
  .option('-v, --verbose', 'verbose output');

// ── init-config ────────────────────────────────────────────────────────────
program
  .command('init-config')
  .description('Generate config.yml from template')
  .option('--output <path>', 'output path', getDefaultConfigPath())
  .option('--force', 'overwrite existing file')
  .action((opts) => {
    if (existsSync(opts.output) && !opts.force) {
      console.error(`Config already exists at ${opts.output} — use --force to overwrite`);
      process.exit(1);
    }
    writeExampleConfig(opts.output);
    console.log(`Config written to: ${opts.output}`);
  });

// ── validate ───────────────────────────────────────────────────────────────
program
  .command('validate')
  .description('Validate config file')
  .action(async () => {
    const cfg = getConfig(program);
    const { validateConfig } = await import('../src/config.js');
    const errors = validateConfig(cfg);
    if (errors.length) { errors.forEach(e => console.error('✗', e)); process.exit(1); }
    console.log('✓ Config is valid');
  });

// ── doctor / preflight ──────────────────────────────────────────────────────
program
  .command('doctor')
  .aliases(['preflight'])
  .description('Run preflight diagnostics')
  .action(async () => {
    const cfg = getConfig(program);
    const log = makeLogger(cfg, program);
    const { runDoctor } = await import('../src/doctor.js');
    const ok = await runDoctor(cfg, log);
    process.exit(ok ? 0 : 1);
  });

// ── plan ────────────────────────────────────────────────────────────────────
program
  .command('plan')
  .description('Build sync plan (no changes)')
  .action(async () => {
    const cfg = getConfig(program);
    const log = makeLogger(cfg, program);
    const { buildSyncPlan } = await import('../src/sync-engine.js');
    const { scanCodexHome } = await import('../src/scanner.js');
    const { createWebDAVClient } = await import('../src/webdav-client.js');

    log.info('Scanning local state…');
    const local = await scanCodexHome(cfg.codex_home);
    const dav = createWebDAVClient(cfg.webdav);
    log.info('Fetching remote file list…');
    const remoteFiles = await dav.list();

    const plan = buildSyncPlan({ localFiles: local.allFiles, remoteFiles, config: cfg });
    console.log(JSON.stringify(plan, null, 2));
  });

// ── sync ────────────────────────────────────────────────────────────────────
program
  .command('sync')
  .description('Sync local <-> remote')
  .option('--dry-run', 'simulate only')
  .option('--apply', 'write files')
  .action(async (opts) => {
    const cfg = getConfig(program);
    const log = makeLogger(cfg, program);
    if (!opts.apply && !opts.dryRun) {
      console.error('Specify --dry-run or --apply'); process.exit(1);
    }

    const { isCodexRunning } = await import('../src/process-check.js');
    if (await isCodexRunning()) {
      log.error('Codex is running — close it before syncing');
      process.exit(3);
    }

    const { scanCodexHome } = await import('../src/scanner.js');
    const { createWebDAVClient } = await import('../src/webdav-client.js');
    const { buildSyncPlan, applyPlan } = await import('../src/sync-engine.js');

    const local = await scanCodexHome(cfg.codex_home);
    const dav = createWebDAVClient(cfg.webdav);
    const remoteFiles = await dav.list();
    const plan = buildSyncPlan({ localFiles: local.allFiles, remoteFiles, config: cfg });

    if (opts.dryRun) {
      console.log('DRY RUN — plan:');
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    const result = await applyPlan({
      plan, config: cfg,
      localBase: cfg.codex_home,
      remoteBase: cfg.webdav.remote_path,
      davClient: dav,
      onProgress: (p) => log.info('sync', p),
    });
    console.log('Sync complete:', result);
  });

// ── restore ─────────────────────────────────────────────────────────────────
program
  .command('restore')
  .description('Restore from backup snapshot')
  .option('--from <snapshot>', 'snapshot name (default: latest)')
  .option('--target <t>', 'local | cloud', 'local')
  .option('--dry-run')
  .option('--apply')
  .action(async (opts) => {
    const cfg = getConfig(program);
    const log = makeLogger(cfg, program);
    if (!opts.apply && !opts.dryRun) {
      console.error('Specify --dry-run or --apply'); process.exit(1);
    }
    const { restoreSnapshot, listSnapshots } = await import('../src/backup.js');
    const snaps = await listSnapshots(cfg.backup_dir);
    if (!snaps.length) { log.error('No backups found'); process.exit(1); }
    const snap = opts.from
      ? snaps.find(s => s.name === opts.from)
      : snaps[snaps.length - 1];
    if (!snap) { log.error(`Snapshot not found: ${opts.from}`); process.exit(1); }
    if (opts.dryRun) { console.log('Would restore:', snap); return; }
    await restoreSnapshot({ snapshot: snap.name, backupDir: cfg.backup_dir, targetDir: cfg.codex_home });
    log.info(`Restored snapshot: ${snap.name}`);
  });

// ── sessions ────────────────────────────────────────────────────────────────
program
  .command('sessions')
  .description('List local sessions')
  .option('--project <name>', 'filter by project name')
  .action(async (opts) => {
    const cfg = getConfig(program);
    const { scanCodexHome } = await import('../src/scanner.js');
    const { sessions } = await scanCodexHome(cfg.codex_home);
    // sessions is { [cwd]: session[] } — flatten to array
    let list = Object.values(sessions).flat();
    if (opts.project) list = list.filter(s => s.project === opts.project);
    list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    list.forEach(s => console.log(`[${(s.updated_at || '').slice(0, 10)}] ${(s.project || '(unknown)').padEnd(20)} ${s.thread_name || s.id}`));
  });

// ── merge-providers ─────────────────────────────────────────────────────────
program
  .command('merge-providers')
  .description('Merge sessions from one login provider into another (openai = ChatGPT web login, custom = API key)')
  .option('--list', 'list providers and session counts')
  .option('--from <provider>', 'source provider, e.g. openai')
  .option('--to <provider>', 'target provider, e.g. custom')
  .option('--dry-run', 'preview only')
  .option('--apply', 'rewrite rollout files and state db')
  .action(async (opts) => {
    const cfg = getConfig(program);
    const log = makeLogger(cfg, program);
    const { listProviders, mergeProviders } = await import('../src/merge.js');

    if (opts.list || (!opts.from && !opts.to)) {
      const { providers } = await listProviders(cfg.codex_home);
      console.log('provider        rollouts  db_threads');
      for (const p of providers) {
        console.log(`${p.provider.padEnd(15)} ${String(p.rollout_count).padStart(8)}  ${String(p.db_count).padStart(10)}`);
      }
      return;
    }

    if (!opts.apply && !opts.dryRun) {
      console.error('Specify --dry-run or --apply'); process.exit(1);
    }

    if (opts.apply) {
      const { isCodexRunning } = await import('../src/process-check.js');
      if (await isCodexRunning()) {
        log.error('Codex is running — close it before merging');
        process.exit(3);
      }
      // 改写前自动备份 sessions + sqlite
      const { createSnapshot } = await import('../src/backup.js');
      const snap = await createSnapshot({
        sourceDir: cfg.codex_home,
        backupDir: cfg.backup_dir,
        compression: cfg.backup.compression,
        include: ['sessions', 'session_index.jsonl', 'state_5.sqlite'],
      });
      log.info(`Pre-merge backup: ${snap}`);
    }

    const result = await mergeProviders({
      codexHome: cfg.codex_home,
      from: opts.from, to: opts.to,
      dryRun: !opts.apply,
    });
    console.log(opts.apply ? 'Merged:' : 'DRY RUN — would merge:');
    console.log(`  rollout files: ${result.rollouts_changed}`);
    console.log(`  db threads:    ${result.db_rows_changed}`);
    if (result.files.length) result.files.forEach(f => console.log(`  - ${f}`));
  });

// ── serve ────────────────────────────────────────────────────────────────────
program
  .command('serve', { isDefault: true })
  .description('Start Web GUI server (default command — plain `cxsync` runs this)')
  .option('--port <n>', 'port', '7420')
  .option('--no-open', 'do not open browser')
  .action(async (opts) => {
    const cfg = getConfig(program);
    cfg.server.port = parseInt(opts.port, 10);
    const log = makeLogger(cfg, program);
    const { startServer } = await import('../src/server.js');
    await startServer(cfg, log, { openBrowser: opts.open !== false });
  });

// ── helpers ──────────────────────────────────────────────────────────────────
function getConfig(prog) {
  const opts = prog.opts();
  const cfgPath = opts.config ?? getDefaultConfigPath();
  return loadConfig(existsSync(cfgPath) ? cfgPath : null);
}

function makeLogger(cfg, prog) {
  const opts = prog.opts();
  return new Logger({
    level: opts.verbose ? 'DEBUG' : cfg.logging.level,
    file: cfg.logging.file,
    format: 'text',
  });
}

program.parse();
