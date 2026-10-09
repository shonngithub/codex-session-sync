# Changelog

## 0.1.1 — 2026-10-09

### 修复 / Fixes

- 合入 PR #1：列出 WebDAV 目录时避免重复拼接 `remote_path`，恢复差异预览及远端独有文件下载。
- Web GUI 和 CLI 不再将认证、权限或网络错误当作空目录；远端列表读取失败时停止同步。
- 规范化 WebDAV 根路径，避免根目录操作产生双斜线；递归子目录读取失败时拒绝返回不完整清单。
- 下载文件保留远端修改时间，避免下次预览反向上传。
- Avoid double-prefixing `remote_path` when listing WebDAV directories (PR #1).
- Surface remote inventory failures in the Web GUI and CLI instead of treating failures as empty directories.
- Normalize root paths and reject incomplete recursive inventories.
- Preserve remote modification times on downloaded files to avoid uploading them back on the next sync.

### 验证 / Validation

27 regression tests pass, covering repeated previews, remote-only downloads, path boundaries, listing failures, and downloaded modification times. Tests use a local WebDAV server and mocked clients; production WebDAV verification is still needed.

### 已知限制 / Known limitations

- Some WebDAV servers reset modification times on upload. Identical older files can still be listed for download; content-hash manifests are not implemented.
- Same-path files, including `session_index.jsonl`, are synchronized as whole files. Cross-machine record merging is not implemented.

Related: https://github.com/shonngithub/codex-session-sync/pull/1
Related: https://github.com/shonngithub/codex-session-sync/issues/2
