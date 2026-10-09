import { jest, test, expect, beforeEach } from '@jest/globals';
const raw = { getDirectoryContents: jest.fn(), putFileContents: jest.fn(), createDirectory: jest.fn() };
jest.unstable_mockModule('webdav', () => ({ createClient: () => raw }));
const { createWebDAVClient } = await import('../src/webdav-client.js');
beforeEach(() => { jest.clearAllMocks(); raw.getDirectoryContents.mockResolvedValue([]); });
test.each([
  ['/Vol2_Home/codex', '', '/Vol2_Home/codex'],
  ['/Vol2_Home/codex', '/Vol2_Home/codex', '/Vol2_Home/codex'],
  ['/Vol2_Home/codex/', '/Vol2_Home/codex/', '/Vol2_Home/codex/'],
  ['/Vol2_Home/codex', '/Vol2_Home/codex/sessions', '/Vol2_Home/codex/sessions'],
  ['/Vol2_Home/codex', 'sessions', '/Vol2_Home/codex/sessions'],
  ['/Vol2_Home/codex', '/Vol2_Home/codex-other', '/Vol2_Home/codex/Vol2_Home/codex-other'],
])('list base %s with argument %s targets %s', async (base, arg, target) => {
  const dav = createWebDAVClient({ url: 'http://localhost', remote_path: base });
  await dav.list(arg);
  expect(raw.getDirectoryContents).toHaveBeenCalledWith(target);
});
test('recursive listing keeps paths relative to the configured base', async () => {
  raw.getDirectoryContents.mockResolvedValueOnce([{ type: 'directory', filename: '/codex/sessions' }])
    .mockResolvedValueOnce([{ type: 'file', filename: '/codex/sessions/a.jsonl', lastmod: '2026-01-01', size: 12 }]);
  const dav = createWebDAVClient({ url: 'http://localhost', remote_path: '/codex' });
  expect(await dav.list('/codex')).toEqual([{ rel: 'sessions/a.jsonl', mtime: Date.parse('2026-01-01'), size: 12 }]);
});
test('missing root is empty, permission/network failures reject', async () => {
  const dav = createWebDAVClient({ url: 'http://localhost', remote_path: '/codex' });
  raw.getDirectoryContents.mockRejectedValueOnce({ status: 404 });
  expect(await dav.list()).toEqual([]);
  for (const err of [{ status: 401 }, { response: { status: 403 } }, new Error('network')]) {
    raw.getDirectoryContents.mockRejectedValueOnce(err);
    await expect(dav.list()).rejects.toEqual(err);
  }
});
test.each(['/', '///'])('root base %s avoids doubled slashes for list and upload', async base => {
  const dav = createWebDAVClient({ url: 'http://localhost', remote_path: base });
  await dav.list('/sessions');
  expect(raw.getDirectoryContents).toHaveBeenCalledWith('/sessions');
  await dav.putFile('sessions/a.jsonl', Buffer.from('a'));
  expect(raw.putFileContents).toHaveBeenCalledWith('/sessions/a.jsonl', Buffer.from('a'), { overwrite: true });
});
test('missing recursive child does not silently return a partial inventory', async () => {
  raw.getDirectoryContents.mockResolvedValueOnce([{ type: 'directory', filename: '/codex/sessions' }])
    .mockRejectedValueOnce({ status: 404 });
  const dav = createWebDAVClient({ url: 'http://localhost', remote_path: '/codex' });
  await expect(dav.list()).rejects.toEqual({ status: 404 });
});
