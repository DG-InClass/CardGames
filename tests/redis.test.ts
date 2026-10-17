import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedisRoomRepository, CREATE_ROOM, SAVE_ROOM, HEARTBEAT } from '../src/server/storage/redis';
import { redisOptions } from '../src/server/application';
import { RoomStore } from '../src/server/rooms';
import { MemoryRepository, RemoteDeck } from './helpers';
import { DISCONNECT_MS, LOCK_MS, RETENTION_SECONDS } from '../src/server/room-types';
import { StorageError } from '../src/server/storage/room-repository';

test('Redis REST encodes atomic commands, keeps credentials in headers, and scopes every key', async () => {
  const memory = new MemoryRepository(); const service = new RoomStore(memory, new RemoteDeck(), () => 1000);
  const host = await service.create('Host'); const room = (await memory.read(host.room.code))!;
  const commands: (string | number)[][] = []; let response: unknown = 1;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://redis.example.test');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private-token');
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.method, 'POST');
    const command = JSON.parse(init!.body as string); commands.push(command);
    assert.ok(!JSON.stringify(command).includes('private-token'));
    return Response.json({ result: response });
  };
  const repository = new RedisRoomRepository(() => ({ url: 'https://redis.example.test', token: 'private-token', namespace: 'test' }), fetcher);
  assert.equal(await repository.create(room, 1000), true);
  const create = commands.at(-1)!;
  assert.deepEqual(create.slice(0, 3), ['EVAL', CREATE_ROOM, 3]);
  assert.ok(create.slice(3, 6).every(key => String(key).startsWith('card-table:{test}:')));
  assert.equal(create[8], 1000 + DISCONNECT_MS); assert.equal(create[9], RETENTION_SECONDS);
  await repository.save(room, 'owner', 2000);
  const save = commands.at(-1)!;
  assert.deepEqual(save.slice(0, 3), ['EVAL', SAVE_ROOM, 4]); assert.equal(save[7], 'owner');
  assert.deepEqual(JSON.parse(save[12] as string), [host.room.you]);
  assert.equal(await repository.heartbeat(room.code, host.room.you, 3000), true);
  assert.equal(commands.at(-1)![1], HEARTBEAT);
  response = 'OK'; assert.equal(await repository.acquire(room.code, 'owner'), true);
  assert.deepEqual(commands.at(-1)!.slice(2), ['owner', 'NX', 'PX', LOCK_MS]);
  response = ['player-a', '123', 'player-b', '456'];
  assert.deepEqual(await repository.presence(room.code), { 'player-a': 123, 'player-b': 456 });
  response = 0;
  await assert.rejects(repository.save(room, 'old-owner', 4000), /lock expired/);
  await assert.rejects(repository.remove(room.code, 'old-owner'), /lock expired/);
});

test('Missing Redis configuration gives a useful error without affecting module initialization', () => {
  const keys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const previous = keys.map(key => process.env[key]);
  try {
    keys.forEach(key => delete process.env[key]);
    assert.throws(redisOptions, /Redis connection configured/);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});

test('Redis transport and decoding failures become portable storage errors', async () => {
  const options = () => ({ url: 'https://redis.example.test', token: 'private-token', namespace: 'test' });
  const failures: (typeof fetch)[] = [
    async () => { throw new Error('Network error with private-token'); },
    async () => new Response('private-token', { status: 500 }),
    async () => new Response('not json'),
    async () => Response.json({ error: 'Provider error with private-token' }),
    async () => Response.json({}),
    async () => Response.json({ result: '{invalid room json' }),
  ];
  for (const fetcher of failures) {
    const repository = new RedisRoomRepository(options, fetcher);
    await assert.rejects(repository.read('ABCDEF'), error => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, 'unavailable');
      assert.ok(!error.message.includes('private-token'));
      return true;
    });
  }
});
