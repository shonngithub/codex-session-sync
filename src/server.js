// src/server.js — Express HTTP server with SSE support
import express from 'express';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dir, '../web');

export async function startServer(cfg, log, { openBrowser = true } = {}) {
  const app = express();
  app.use(express.json());

  // ── static web GUI ───────────────────────────────────────────────────────
  app.use(express.static(WEB_DIR));
  app.get('/', (_req, res) => res.sendFile(resolve(WEB_DIR, 'index.html')));

  // ── inject config into server context ────────────────────────────────────
  app.locals.cfg = cfg;
  app.locals.log = log;

  // ── API routes ────────────────────────────────────────────────────────────
  const { router: sessionRouter } = await import('./api/sessions.js');
  const { router: syncRouter }    = await import('./api/sync.js');
  const { router: backupRouter }  = await import('./api/backup.js');
  const { router: webdavRouter }  = await import('./api/webdav.js');
  const { router: configRouter }  = await import('./api/config.js');
  const { router: mergeRouter }   = await import('./api/merge.js');

  app.use('/api/sessions', sessionRouter);
  app.use('/api/sync',     syncRouter);
  app.use('/api',          backupRouter);
  app.use('/api/config',   webdavRouter);
  app.use('/api/config',   configRouter);
  app.use('/api',          mergeRouter);

  // ── health ────────────────────────────────────────────────────────────────
  app.get('/api/health', async (_req, res) => {
    const { isCodexRunning } = await import('./process-check.js');
    const codex_running = await isCodexRunning().catch(() => null);
    res.json({ ok: true, codex_running, version: '0.1.1' });
  });

  // ── 404 fallback ──────────────────────────────────────────────────────────
  // API 路径必须返回 JSON 404，不能落到 SPA fallback 返回 HTML
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found (server may be outdated — restart cxsync serve)' }));
  app.use((_req, res) => res.sendFile(resolve(WEB_DIR, 'index.html')));

  // ── error handler ─────────────────────────────────────────────────────────
  app.use((err, _req, res, _next) => {
    log.error('Unhandled error', { message: err.message });
    res.status(500).json({ error: err.message });
  });

  const server = createServer(app);
  const port = cfg.server?.port ?? 7420;

  await new Promise((res, rej) => {
    server.listen(port, '127.0.0.1', () => res());
    server.once('error', rej);
  });

  const url = `http://localhost:${port}`;
  log.info(`Web GUI running at ${url}`);
  console.log(`\n  cxsync Web GUI → ${url}\n`);

  if (openBrowser) {
    const { default: open } = await import('open');
    open(url).catch(() => {});
  }

  return server;
}

// ── SSE helper (shared by sync and backup routes) ──────────────────────────
export function sseStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const end = () => res.end();
  return { send, end };
}
