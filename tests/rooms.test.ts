import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore, DISCONNECT_MS, ROOM_LIFETIME_MS } from '../src/server/rooms';
import { MemoryRepository, RemoteDeck, deck } from './helpers';

function fixture() {
  let now = 1_000_000;
  const repository = new MemoryRepository(); const api = new RemoteDeck();
  const fresh = () => new RoomStore(repository, api, () => now);
  return { repository, api, fresh, store: fresh(), advance: (ms: number) => { now += ms; } };
}
async function table(count = 2) {
  const f = fixture();
  const host = await f.store.create('Host');
  const seats = [host];
  for (let i = 1; i < count; i++) seats.push(await f.fresh().join(host.room.code, `Guest ${i}`));
  const view = await f.fresh().action(host.room.code, host.token, count - 1, { type: 'start' });
  return { ...f, seats, host, code: host.room.code, view };
}

test('Independent instances enforce four seats, unique names, tokens and host-only dealing', async () => {
  const f = fixture(); const host = await f.store.create('Host'); const code = host.room.code;
  const guest = await f.fresh().join(code, 'Guest');
  await assert.rejects(f.fresh().join(code, 'guest'), /taken/);
  await f.fresh().join(code, 'Third');
  const competing = await Promise.allSettled([f.fresh().join(code, 'Fourth'), f.fresh().join(code, 'Fifth')]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(f.store.join(code, 'Another'), /full/);
  assert.deepEqual(await f.store.list(), []);
  await assert.rejects(f.fresh().get(code, 'invalid-token'), /expired/);
  await assert.rejects(f.fresh().action(code, guest.token, 3, { type: 'start' }), /Only the host/);
});

test('A fresh function restores private hands from piles without storing hands or stock in Redis', async () => {
  const f = await table();
  const view = await f.fresh().get(f.code, f.host.token);
  assert.equal(view.hand.length, 7); assert.equal(view.stockCount, 38);
  const encoded = JSON.stringify(view);
  assert.ok(!encoded.includes('remote-deck') && !encoded.includes(f.host.token) && !encoded.includes(f.seats[1].token));
  assert.ok(view.players.every(player => !('hand' in player) && !('tokenHash' in player)));
  const record = await f.repository.read(f.code);
  assert.ok(record && !('stock' in record) && record.players.every(player => !('hand' in player)));
  assert.deepEqual(record.pending, []);
  assert.ok(!JSON.stringify(record).includes('"code":"AS"'));
  await assert.rejects(f.fresh().action(f.code, f.host.token, 1, { type: 'start' }), /table changed/);
  await assert.rejects(f.fresh().join(f.code, 'Late'), /already started/);
  const next = await f.fresh().action(f.code, f.host.token, view.version, { type: 'ask', opponent: f.seats[1].room.you, rank: view.hand[0].value });
  f.api.assertComplete(); assert.equal(next.version, view.version + 1);
  await assert.rejects(f.fresh().action(f.code, f.host.token, view.version, { type: 'ask', opponent: f.seats[1].room.you, rank: view.hand[0].value }), /table changed/);
});

test('Active polls reclaim disconnected seats and return their remote hand to the pond', async () => {
  const f = await table(3);
  f.advance(30_000);
  await f.fresh().get(f.code, f.host.token); await f.fresh().get(f.code, f.seats[2].token);
  f.advance(DISCONNECT_MS - 30_000 + 1);
  const view = await f.fresh().get(f.code, f.host.token);
  assert.equal(view.players.length, 2); assert.equal(view.stockCount, 42); assert.equal(view.status, 'playing');
  assert.equal(f.api.returned.length, 5); f.api.assertComplete();
  await assert.rejects(f.fresh().get(f.code, f.seats[1].token), /expired/);
});

test('Departure returns completed books as well as hand cards through named API piles', async () => {
  const f = await table(3); const id = f.host.room.you;
  const aces = deck.filter(card => card.value === 'ACE');
  await f.api.move('remote-deck', `books_${id}`, aces.map(card => card.code));
  const record = f.repository.records.get(f.code)!; record.players[0].books = ['ACE'];
  const expected = [...f.api.piles[`hand_${id}`], ...f.api.piles[`books_${id}`]].map(card => card.code).sort();
  await f.fresh().leave(f.code, f.host.token);
  assert.deepEqual([...f.api.returned].sort(), expected);
  const view = await f.fresh().get(f.code, f.seats[1].token);
  assert.equal(view.host, f.seats[1].room.you); assert.equal(view.turn, f.seats[1].room.you);
  assert.equal(view.players.length, 2); f.api.assertComplete();
});

test('All players expiring together returns every pile and removes the room', async () => {
  const f = await table(4); f.advance(DISCONNECT_MS + 1);
  await f.fresh().sweep();
  assert.equal(await f.repository.read(f.code), null);
  assert.equal(f.api.piles.stock.length, 52); assert.equal(f.api.returned.length, 20); f.api.assertComplete();
});

test('A lost API response resumes on a fresh instance with no duplicated cards', async () => {
  const f = fixture(); const host = await f.store.create('Host'); const code = host.room.code;
  await f.fresh().join(code, 'Guest'); f.api.loseMoveResponse = true;
  const pending = await f.store.action(code, host.token, 1, { type: 'start' });
  assert.ok(pending.syncing && pending.syncError); assert.deepEqual(pending.hand, []);
  assert.ok((await f.repository.read(code))!.pending.length > 0);
  const recovered = await f.fresh().get(code, host.token);
  assert.equal(recovered.syncing, false); assert.equal(recovered.syncError, false);
  assert.equal(recovered.hand.length, 7); assert.equal(recovered.stockCount, 38); f.api.assertComplete();
});

test('An outage pauses moves until the journal recovers', async () => {
  const f = fixture(); const host = await f.store.create('Host'); const code = host.room.code;
  await f.store.join(code, 'Guest'); f.api.failMove = true;
  const pending = await f.store.action(code, host.token, 1, { type: 'start' });
  await assert.rejects(f.fresh().action(code, host.token, pending.version, { type: 'start' }), /syncing/);
  f.api.failMove = false;
  const recovered = await f.fresh().get(code, host.token);
  assert.equal(recovered.syncing, false); f.api.assertComplete();
});

test('A Redis acknowledgement lost after a journal checkpoint can safely replay the operation', async () => {
  const f = fixture(); const host = await f.store.create('Host'); const code = host.room.code;
  await f.store.join(code, 'Guest');
  const save = f.repository.save.bind(f.repository); let failed = false;
  f.repository.save = async (room, owner, now) => {
    await save(room, owner, now);
    if (!failed && room.deck && room.pending.length === 2) { failed = true; throw new Error('Redis response lost'); }
  };
  const pending = await f.store.action(code, host.token, 1, { type: 'start' });
  assert.equal(pending.syncing, true); assert.ok(failed);
  const recovered = await f.fresh().get(code, host.token);
  assert.equal(recovered.syncing, false); f.api.assertComplete();
});

test('Lost lock ownership stops remote mutations and leaves a recoverable journal', async () => {
  const f = fixture(); const host = await f.store.create('Host'); const code = host.room.code;
  await f.store.join(code, 'Guest');
  f.api.beforeMove = () => f.repository.locks.set(code, 'another-owner');
  await assert.rejects(f.store.action(code, host.token, 1, { type: 'start' }), /Lock expired/);
  assert.equal(f.api.moves, 0); assert.equal(f.repository.locks.get(code), 'another-owner');
  f.api.beforeMove = undefined; f.repository.locks.delete(code);
  const recovered = await f.fresh().get(code, host.token);
  assert.equal(recovered.syncing, false); f.api.assertComplete();
});

test('Expired and empty waiting rooms are removed without creating a deck', async () => {
  const f = fixture(); const host = await f.store.create('Host');
  f.advance(ROOM_LIFETIME_MS + 1); await f.fresh().sweep();
  await assert.rejects(f.store.get(host.room.code, host.token), /expired/);
  const next = await f.store.create('Next'); await f.fresh().leave(next.room.code, next.token);
  assert.deepEqual(await f.store.list(), []); assert.equal(f.api.drawn.length, 0);
});

test('One inaccessible deck does not prevent cleanup of other abandoned rooms', async () => {
  const f = await table();
  const waiting = await f.fresh().create('Waiting');
  f.api.pile = async () => { throw new Error('External deck unavailable'); };
  f.advance(DISCONNECT_MS + 1);
  const result = await f.fresh().sweep();
  assert.equal(result.failed, 1); assert.equal(result.processed, 1);
  assert.ok(await f.repository.read(f.code));
  assert.equal(await f.repository.read(waiting.room.code), null);
});
