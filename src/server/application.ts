import type { GoFishService } from './go-fish-service';
import { RoomStore } from './rooms';
import { RedisRoomRepository, type RedisOptions } from './storage/redis';
import { StorageError } from './storage/room-repository';

export function redisOptions(): RedisOptions {
  // Static import.meta.env accesses support Astro's local .env replacement;
  // process.env supplies the runtime values in Vercel functions.
  const url = process.env.UPSTASH_REDIS_REST_URL || import.meta.env?.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || import.meta.env?.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || import.meta.env?.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || import.meta.env?.KV_REST_API_TOKEN;
  if (!url || !token) throw new StorageError('configuration', 'Go Fish needs its Redis connection configured on the server. Solitaire is still available.');
  if (!url.startsWith('https://')) throw new StorageError('configuration', 'The Redis connection must use HTTPS.');
  const environment = process.env.VERCEL_ENV || import.meta.env?.VERCEL_ENV;
  const deployment = process.env.VERCEL_URL || import.meta.env?.VERCEL_URL;
  const namespace = process.env.CARD_TABLE_NAMESPACE || import.meta.env?.CARD_TABLE_NAMESPACE || (environment === 'production' ? 'production' : environment === 'preview' ? `preview-${deployment}` : 'local');
  return { url: url.replace(/\/$/, ''), token, namespace };
}

// Select the production storage adapter here. Configuration is read lazily so
// public pages and Solitaire still work when multiplayer storage is unconfigured.
// To change providers, supply another RoomRepository to the same RoomStore.
export const rooms: GoFishService = new RoomStore(new RedisRoomRepository(redisOptions));
