import type { RoomRecord } from '../room-types';

export type StorageErrorCode = 'configuration' | 'unavailable' | 'capacity' | 'conflict';

/** Provider-neutral failures. HTTP status codes belong in the HTTP layer. */
export class StorageError extends Error {
  constructor(public readonly code: StorageErrorCode, message: string) { super(message); }
}

/**
 * Server-only storage API. All times are Unix milliseconds; codes are uppercase.
 * Returned records are detached snapshots. Mutating them must never persist data.
 * Methods must work across independent application instances in one namespace.
 * Implementations use the policy constants in room-types.ts for retention,
 * heartbeat grace, capacity, and lock lifetime (including equivalent SQL leases).
 * Failures use StorageError; adapters never call Deck of Cards API.
 */
export interface RoomRepository {
  /** Atomically create metadata + host presence + cleanup index, respecting MAX_ROOMS.
   * False means code collision; capacity exhaustion throws 'capacity'. */
  create(room: RoomRecord, now: number): Promise<boolean>;
  /** Missing/retention-expired metadata returns null. Logical game expiry is handled by the service. */
  read(code: string): Promise<RoomRecord | null>;
  /** Candidate rooms whose next cleanup time >= now. The service filters joinability. */
  list(now: number): Promise<RoomRecord[]>;
  /** At most MAX_ROOMS codes due at/before now, oldest first. May include orphan index entries. */
  due(now: number): Promise<string[]>;
  /** Missing presence returns an empty object; missing seats have no entry. */
  presence(code: string): Promise<Record<string, number>>;
  /** Atomically refresh existing, unexpired presence and schedule cleanup.
   * False for missing/expired seats; never recreate or revive a seat. Does not require the room lock. */
  heartbeat(code: string, id: string, now: number): Promise<boolean>;
  /** Atomically acquire an exclusive LOCK_MS lease; false if already owned.
   * The service supplies a new, unique owner token for each attempt. */
  acquire(code: string, owner: string): Promise<boolean>;
  /** True only while the unexpired lease still belongs to owner. */
  owns(code: string, owner: string): Promise<boolean>;
  /** Atomically verify ownership, replace metadata, refresh retention, and schedule cleanup.
   * Preserve current seats' heartbeats, initialize new seats, remove departed seats.
   * Throw 'conflict' without writing anything when ownership is lost. */
  save(room: RoomRecord, owner: string, now: number): Promise<void>;
  /** Atomically verify ownership and remove metadata, presence, and cleanup index.
   * Must also work for orphan index entries; leave the lock for release(). */
  remove(code: string, owner: string): Promise<void>;
  /** Atomically release only owner's lease. A missing/different owner is a no-op. */
  release(code: string, owner: string): Promise<void>;
}
