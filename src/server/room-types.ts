import type { Rank } from '../lib/cards';
import type { FishGame } from '../lib/go-fish';

export const DISCONNECT_MS = 45_000;
export const ROOM_LIFETIME_MS = 2 * 60 * 60 * 1000;
export const RETENTION_SECONDS = 14 * 24 * 60 * 60;
// Longer than Vercel's configured 60-second invocation limit plus an API timeout.
export const LOCK_MS = 120_000;
export const MAX_ROOMS = 100;

export class RoomError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type Seat = { id: string; name: string; tokenHash: string; books: Rank[] };
export type CardOperation =
  | { type: 'move'; pile: string; codes: string[] }
  | { type: 'return'; pile: string; codes: string[] }
  | { type: 'restore-stock'; codes: string[] }
  | { type: 'shuffle' };

// No stock or hand arrays here. Card codes exist only in unfinished operations,
// and are removed after the external API confirms the operation.
export type RoomRecord = {
  code: string; deck?: string; version: number; expiresAt: number;
  status: FishGame['status']; host: string; turn: string | null;
  players: Seat[]; log: string[]; winners: string[];
  pending: CardOperation[]; syncError: boolean;
};
