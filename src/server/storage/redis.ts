import { DISCONNECT_MS, LOCK_MS, MAX_ROOMS, RETENTION_SECONDS, type RoomRecord } from '../room-types';
import { StorageError, type RoomRepository } from './room-repository';

export type RedisOptions = { url: string; token: string; namespace: string };

// Lua keeps the room, presence, and room index consistent in one operation.
// All keys share a Redis hash tag, including on clustered Redis deployments.
export const CREATE_ROOM = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return -1 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('HSET', KEYS[3], ARGV[6], ARGV[7])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1`;

export const SAVE_ROOM = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[4])
local ids = cjson.decode(ARGV[6])
local keep = {}
for _, id in ipairs(ids) do
  keep[id] = true
  redis.call('HSETNX', KEYS[4], id, ARGV[7])
end
for _, id in ipairs(redis.call('HKEYS', KEYS[4])) do
  if not keep[id] then redis.call('HDEL', KEYS[4], id) end
end
redis.call('EXPIRE', KEYS[4], ARGV[3])
return 1`;

export const HEARTBEAT = `
local last = redis.call('HGET', KEYS[1], ARGV[1])
if not last or tonumber(ARGV[2]) - tonumber(last) > tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('ZADD', KEYS[2], tonumber(ARGV[2]) + tonumber(ARGV[3]), ARGV[4])
return 1`;

const REMOVE_ROOM = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[2], KEYS[3])
redis.call('ZREM', KEYS[4], ARGV[2])
return 1`;
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export class RedisRoomRepository implements RoomRepository {
  constructor(private config: () => RedisOptions, private fetcher: typeof fetch = fetch) {}

  private keys(code = '') {
    const prefix = `card-table:{${this.config().namespace.replace(/[{}]/g, '')}}`;
    return { room: `${prefix}:room:${code}`, presence: `${prefix}:presence:${code}`, lock: `${prefix}:lock:${code}`, index: `${prefix}:rooms` };
  }

  private async command<T>(...command: (string | number)[]): Promise<T> {
    const { url, token } = this.config();
    try {
      const response = await this.fetcher(url, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command), cache: 'no-store', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Redis HTTP error');
      const data = await response.json() as { result: T; error?: string };
      if (data.error || !Object.hasOwn(data, 'result')) throw new Error('Redis command error');
      return data.result;
    } catch {
      // Never leak provider responses, URLs, or credentials through the boundary.
      throw new StorageError('unavailable', 'The lobby storage is unavailable. Please try again.');
    }
  }

  private decodeRoom(value: string): RoomRecord {
    try { return JSON.parse(value) as RoomRecord; }
    catch { throw new StorageError('unavailable', 'Stored room metadata could not be read.'); }
  }

  async create(room: RoomRecord, now: number) {
    const key = this.keys(room.code);
    const result = await this.command<number>('EVAL', CREATE_ROOM, 3, key.room, key.index, key.presence,
      JSON.stringify(room), room.code, now + DISCONNECT_MS, RETENTION_SECONDS, MAX_ROOMS, room.players[0].id, now);
    if (result === -1) throw new StorageError('capacity', 'All tables are busy. Try again later.');
    return result === 1;
  }
  async read(code: string) {
    const value = await this.command<string | null>('GET', this.keys(code).room);
    return value ? this.decodeRoom(value) : null;
  }
  async list(now: number) {
    const codes = await this.command<string[]>('ZRANGEBYSCORE', this.keys().index, now, '+inf');
    if (!codes.length) return [];
    const values = await this.command<(string | null)[]>('MGET', ...codes.map(code => this.keys(code).room));
    return values.flatMap(value => value ? [this.decodeRoom(value)] : []);
  }
  async due(now: number) {
    return this.command<string[]>('ZRANGEBYSCORE', this.keys().index, '-inf', now, 'LIMIT', 0, MAX_ROOMS);
  }
  async presence(code: string) {
    const pairs = await this.command<string[]>('HGETALL', this.keys(code).presence);
    const result: Record<string, number> = {};
    for (let index = 0; index < pairs.length; index += 2) result[pairs[index]] = Number(pairs[index + 1]);
    return result;
  }
  async heartbeat(code: string, id: string, now: number) {
    const key = this.keys(code);
    return await this.command<number>('EVAL', HEARTBEAT, 2, key.presence, key.index, id, now, DISCONNECT_MS, code, RETENTION_SECONDS) === 1;
  }
  async acquire(code: string, owner: string) {
    return await this.command<string | null>('SET', this.keys(code).lock, owner, 'NX', 'PX', LOCK_MS) === 'OK';
  }
  async owns(code: string, owner: string) { return await this.command('GET', this.keys(code).lock) === owner; }
  async save(room: RoomRecord, owner: string, now: number) {
    const key = this.keys(room.code);
    const saved = await this.command<number>('EVAL', SAVE_ROOM, 4, key.lock, key.room, key.index, key.presence,
      owner, JSON.stringify(room), RETENTION_SECONDS, room.code, now + DISCONNECT_MS,
      JSON.stringify(room.players.map(player => player.id)), now);
    if (!saved) throw new StorageError('conflict', 'The table lock expired. Refresh before making another move.');
  }
  async remove(code: string, owner: string) {
    const key = this.keys(code);
    const removed = await this.command<number>('EVAL', REMOVE_ROOM, 4, key.lock, key.room, key.presence, key.index, owner, code);
    if (!removed) throw new StorageError('conflict', 'The table lock expired.');
  }
  async release(code: string, owner: string) {
    await this.command('EVAL', RELEASE_LOCK, 1, this.keys(code).lock, owner);
  }
}
