import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIRoute } from 'astro';
import { createGoFishHandlers } from '../src/server/http/go-fish';
import { createCleanupHandler } from '../src/server/http/cleanup';
import { RoomStore } from '../src/server/rooms';
import { StorageError, type StorageErrorCode } from '../src/server/storage/room-repository';
import { MemoryRepository, RemoteDeck } from './helpers';

const context = (request: Request) => ({ request, url: new URL(request.url) }) as Parameters<APIRoute>[0];
function fixture(repository = new MemoryRepository()) {
  const service = new RoomStore(repository, new RemoteDeck());
  const { GET, POST } = createGoFishHandlers(service);
  const post = (body: object, token?: string) => POST(context(new Request('https://card-table.test/api/gofish', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  })));
  return { service, GET, post };
}

test('HTTP API works through an injected storage adapter without importing production Redis', async () => {
  const { GET, post } = fixture();
  const created = await post({ type: 'create', name: 'Host' });
  assert.equal(created.status, 201); assert.equal(created.headers.get('Cache-Control'), 'no-store');
  const host = await created.json(); assert.match(host.room.code, /^[A-F0-9]{6}$/);
  const listed = await GET(context(new Request('https://card-table.test/api/gofish')));
  assert.equal((await listed.json())[0].code, host.room.code);
  const joined = await post({ type: 'join', code: host.room.code, name: 'Guest' });
  assert.equal((await joined.json()).room.players.length, 2);
  const started = await post({ type: 'start', code: host.room.code, version: 1 }, host.token);
  assert.equal((await started.json()).hand.length, 7);
  const privateView = await GET(context(new Request(`https://card-table.test/api/gofish?room=${host.room.code}`, { headers: { Authorization: `Bearer ${host.token}` } })));
  assert.equal((await privateView.json()).stockCount, 38);
  const invalid = await GET(context(new Request('https://card-table.test/api/gofish?room=invalid/path')));
  assert.equal(invalid.status, 400);
  assert.equal((await post({ type: 'create', name: 'a'.repeat(5000) })).status, 413);
});

test('HTTP instances share only the storage supplied to them', async () => {
  const repository = new MemoryRepository();
  const first = fixture(repository); const second = fixture(repository); const isolated = fixture();
  const created = await first.post({ type: 'create', name: 'Host' });
  const host = await created.json();
  const joined = await second.post({ type: 'join', code: host.room.code, name: 'Guest' });
  assert.equal((await joined.json()).room.players.length, 2);
  const missing = await isolated.post({ type: 'join', code: host.room.code, name: 'Guest' });
  assert.equal(missing.status, 404);
  const list = await isolated.GET(context(new Request('https://card-table.test/api/gofish')));
  assert.deepEqual(await list.json(), []);
});

test('Provider failures map to stable HTTP errors without exposing provider diagnostics', async () => {
  const cases: [StorageErrorCode, number, string][] = [
    ['configuration', 503, 'Multiplayer storage is not configured. Solitaire is still available.'],
    ['unavailable', 503, 'The lobby storage is unavailable. Please try again shortly.'],
    ['capacity', 503, 'All tables are busy. Try again later.'],
    ['conflict', 409, 'The table changed. Refresh and try again.'],
  ];
  for (const [code, status, message] of cases) {
    const repository = new MemoryRepository();
    repository.list = async () => { throw new StorageError(code, 'Provider diagnostic with private-token'); };
    const { GET } = fixture(repository);
    const response = await GET(context(new Request('https://card-table.test/api/gofish')));
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: message });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('Cleanup rejects missing or incorrect secrets and only runs with the configured bearer token', async () => {
  let secret: string | undefined; let calls = 0;
  const cleanup = createCleanupHandler({ sweep: async () => { calls++; return { processed: 3 }; } }, () => secret);
  assert.equal((await cleanup(context(new Request('https://card-table.test/api/gofish-cleanup')))).status, 401);
  secret = 'test-cron-secret';
  assert.equal((await cleanup(context(new Request('https://card-table.test/api/gofish-cleanup', { headers: { Authorization: 'Bearer wrong' } })))).status, 401);
  const response = await cleanup(context(new Request('https://card-table.test/api/gofish-cleanup', { headers: { Authorization: 'Bearer test-cron-secret' } })));
  assert.deepEqual(await response.json(), { processed: 3 }); assert.equal(calls, 1);
});

test('Cleanup uses the same provider-independent failure mapping as the game API', async () => {
  const cleanup = createCleanupHandler({ sweep: async () => { throw new StorageError('unavailable', 'private-token'); } }, () => 'secret');
  const response = await cleanup(context(new Request('https://card-table.test/api/gofish-cleanup', { headers: { Authorization: 'Bearer secret' } })));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'The lobby storage is unavailable. Please try again shortly.' });
});
