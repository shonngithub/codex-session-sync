# codex-session-sync — REST API

Base URL: `http://localhost:7420`

All responses are JSON unless noted. Errors return `{ "error": "message" }`.

---

## Sessions

### GET /api/sessions
List all sessions from `session_index.jsonl`, grouped by project (cwd).

Response:
```json
{
  "sessions": [
    {
      "id": "019f1b39-...",
      "thread_name": "排查 brain node 超时原因",
      "updated_at": "2026-07-01T01:09:34Z",
      "cwd": "C:/Users/xw/project/foo",
      "project": "foo",
      "file": "sessions/2026/07/01/rollout-2026-07-01T09-09-26-019f1b39.jsonl",
      "size_bytes": 4096,
      "message_count": 12
    }
  ],
  "total": 42
}
```

### GET /api/sessions/:id
Get metadata + first 20 messages of a single session.

### PATCH /api/sessions/:id
```json
{ "thread_name": "new name" }
```
Writes new name into `session_index.jsonl`.

---

## Sync

### POST /api/sync/plan
Build a sync plan without writing any files.

Request: `{}` (uses current config)

Response:
```json
{
  "plan": {
    "to_upload": ["sessions/2026/07/17/..."],
    "to_download": [],
    "conflicts": [],
    "unchanged": 14
  }
}
```

### POST /api/sync/apply
Execute sync. Streams SSE events on the same connection.

`Content-Type: text/event-stream`

Events:
```
data: {"type":"start","total":5}
data: {"type":"progress","file":"sessions/...","action":"upload","n":1,"total":5}
data: {"type":"conflict","file":"...","policy":"manual_abort"}
data: {"type":"done","uploaded":3,"downloaded":0,"skipped":2,"errors":0}
data: {"type":"error","file":"...","message":"..."}
```

---

## Backup & Restore

### GET /api/backups
List local backup snapshots.

```json
{
  "backups": [
    { "name": "2026-07-17T08-30-00", "created_at": "2026-07-17T08:30:00Z", "size_bytes": 2048000, "format": "zip" }
  ]
}
```

### POST /api/backup
Create a manual backup snapshot immediately.

### POST /api/restore
```json
{ "snapshot": "2026-07-17T08-30-00", "target": "local" }
```
`target`: `local` | `cloud`

Streams SSE like sync/apply.

---

## Config

### GET /api/config
Returns current config (passwords masked).

### PUT /api/config
Update config. Only provided keys are updated.

---

## WebDAV

### POST /api/config/webdav/test
```json
{ "url": "https://...", "username": "u", "password": "p", "remote_path": "/codex-sync" }
```

Response:
```json
{ "ok": true, "latency_ms": 42, "free_bytes": 10737418240 }
```
or `{ "ok": false, "error": "401 Unauthorized" }`

---

## Health

### GET /api/health
```json
{ "ok": true, "codex_running": false, "version": "0.1.1" }
```
