import type { Rank } from '../lib/cards';
import type { RoomSummary, RoomView } from '../lib/go-fish';

export type FishAction = { type: 'start' } | { type: 'ask'; opponent: string; rank: Rank };
export type SeatSession = { token: string; room: RoomView };
export type CleanupResult = { processed: number; failed?: number };

/** Application API consumed by HTTP handlers; no storage-provider or HTTP types. */
export interface GoFishService {
  list(): Promise<RoomSummary[]>;
  create(name: unknown): Promise<SeatSession>;
  join(code: string, name: unknown): Promise<SeatSession>;
  get(code: string, token: string): Promise<RoomView>;
  action(code: string, token: string, version: number, action: FishAction): Promise<RoomView>;
  leave(code: string, token: string): Promise<void>;
  sweep(limit?: number): Promise<CleanupResult>;
}
