// src/api/sync.js — POST /api/sync/plan, POST /api/sync/apply (SSE)
import { Router } from 'express';
import { scanCodexHome } from '../scanner.js';
import { createWebDAVClient } from '../webdav-client.js';
import { buildSyncPlan, applyPlan } from '../sync-engine.js';
import { isCodexRunning } from '../process-check.js';
import { sseStream } from '../server.js';

export const router = Router();

router.post('/plan', async (req, res) => {
  const cfg = req.app.locals.cfg;
  try {
    const local = await scanCodexHome(cfg.codex_home);
    const dav = createWebDAVClient(cfg.webdav);
    const remoteFiles = await dav.list();
    const plan = buildSyncPlan({ localFiles: local.allFiles, remoteFiles, config: cfg });
    res.json({ plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/apply', async (req, res) => {
  const cfg = req.app.locals.cfg;
  const log = req.app.locals.log;
  const sse = sseStream(res);

  try {
    const running = await isCodexRunning();
    if (running) {
      sse.send({ type: 'error', message: 'Codex is running — close it before syncing' });
      sse.end(); return;
    }

    const local = await scanCodexHome(cfg.codex_home);
    const dav = createWebDAVClient(cfg.webdav);
    const remoteFiles = await dav.list();
    const plan = buildSyncPlan({ localFiles: local.allFiles, remoteFiles, config: cfg });

    const total = plan.to_upload.length + plan.to_download.length;
    sse.send({ type: 'start', total });

    const result = await applyPlan({
      plan, config: cfg,
      localBase: cfg.codex_home,
      remoteBase: cfg.webdav.remote_path,
      davClient: dav,
      onProgress: (p) => {
        log.info('sync progress', p);
        sse.send({ type: 'progress', ...p, total });
      },
    });

    sse.send({ type: 'done', ...result });
  } catch (e) {
    log.error('sync error', { message: e.message });
    sse.send({ type: 'error', message: e.message });
  } finally {
    sse.end();
  }
});
