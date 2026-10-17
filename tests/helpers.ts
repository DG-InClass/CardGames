import assert from 'node:assert/strict';
import { RANKS, SUITS, rankLabel, type Card } from '../src/lib/cards';
import type { DeckGateway, Guard } from '../src/lib/deck-api';
import { DISCONNECT_MS, MAX_ROOMS, type RoomRecord } from '../src/server/room-types';
import { StorageError, type RoomRepository } from '../src/server/storage/room-repository';

export const deck: Card[] = SUITS.flatMap(suit => RANKS.map(value => ({ code: `${value === '10' ? '0' : rankLabel(value)}${suit[0]}`, suit, value, image: '' })));

// Test-only remote stores shared by independent RoomStore instances.
export class MemoryRepository implements RoomRepository {
  records = new Map<string, RoomRecord>();
  seen = new Map<string, Record<string, number>>();
  locks = new Map<string, string>();
  index = new Map<string, number>();
  async create(room: RoomRecord, now: number) {
    if (this.records.has(room.code)) return false;
    if (this.records.size >= MAX_ROOMS) throw new StorageError('capacity', 'All tables are busy.');
    this.records.set(room.code, structuredClone(room));
    this.seen.set(room.code, { [room.host]: now });
    this.index.set(room.code, now + DISCONNECT_MS);
    return true;
  }
  async read(code: string) { return structuredClone(this.records.get(code) ?? null); }
  async list(now: number) { return structuredClone([...this.records.values()].filter(room => (this.index.get(room.code) ?? 0) >= now)); }
  async due(now: number) { return [...this.index].filter(([, due]) => due <= now).map(([code]) => code); }
  async presence(code: string) { return structuredClone(this.seen.get(code) ?? {}); }
  async heartbeat(code: string, id: string, now: number) {
    const seen = this.seen.get(code);
    if (!seen || seen[id] === undefined || now - seen[id] > DISCONNECT_MS) return false;
    seen[id] = now;
    this.index.set(code, now + DISCONNECT_MS);
    return true;
  }
  async acquire(code: string, owner: string) {
    if (this.locks.has(code)) return false;
    this.locks.set(code, owner); return true;
  }
  async owns(code: string, owner: string) { return this.locks.get(code) === owner; }
  async save(room: RoomRecord, owner: string, now: number) {
    if (!await this.owns(room.code, owner)) throw new StorageError('conflict', 'Lock expired.');
    this.records.set(room.code, structuredClone(room));
    const seen = this.seen.get(room.code) ?? {};
    this.seen.set(room.code, Object.fromEntries(room.players.map(player => [player.id, seen[player.id] ?? now])));
    this.index.set(room.code, now + DISCONNECT_MS);
  }
  async remove(code: string, owner: string) {
    if (!await this.owns(code, owner)) throw new StorageError('conflict', 'Lock expired.');
    this.records.delete(code); this.seen.delete(code); this.index.delete(code);
  }
  async release(code: string, owner: string) { if (await this.owns(code, owner)) this.locks.delete(code); }
}

export class RemoteDeck implements DeckGateway {
  piles: Record<string, Card[]> = {};
  main: Card[] = [];
  drawn: Card[] = [];
  returned: string[] = [];
  moves = 0;
  failMove = false;
  loseMoveResponse = false;
  beforeMove?: () => void;
  async create(guard?: Guard) { await guard?.(); this.drawn = structuredClone(deck); return { id: 'remote-deck', cards: structuredClone(deck) }; }
  async pile(_deck: string, pile: string) {
    assert.ok(this.piles[pile], `Only list existing API piles: ${pile}`);
    return { cards: structuredClone(this.piles[pile]), counts: Object.fromEntries(Object.entries(this.piles).map(([name, cards]) => [name, cards.length])), remaining: this.main.length };
  }
  async move(_deck: string, pile: string, codes: string[], guard?: Guard) {
    this.beforeMove?.(); await guard?.(); this.moves++;
    if (this.failMove) throw new Error('Card service offline');
    const cards = [...this.drawn, ...Object.values(this.piles).flat()].filter(card => codes.includes(card.code));
    assert.equal(cards.length, codes.length);
    for (const name of Object.keys(this.piles)) this.piles[name] = this.piles[name].filter(card => !codes.includes(card.code));
    this.drawn = this.drawn.filter(card => !codes.includes(card.code));
    (this.piles[pile] ??= []).push(...cards);
    if (this.loseMoveResponse) { this.loseMoveResponse = false; throw new Error('Response lost after move succeeded'); }
  }
  async returnPile(_deck: string, pile: string, codes: string[], guard?: Guard) {
    await guard?.();
    const cards = (this.piles[pile] ?? []).filter(card => codes.includes(card.code));
    this.returned.push(...cards.map(card => card.code));
    this.main.push(...cards);
    this.piles[pile] = (this.piles[pile] ?? []).filter(card => !codes.includes(card.code));
  }
  async restoreStock(_deck: string, codes: string[], guard?: Guard) {
    await guard?.();
    const cards = this.main.filter(card => codes.includes(card.code));
    assert.equal(cards.length, codes.length);
    this.main = this.main.filter(card => !codes.includes(card.code));
    (this.piles.stock ??= []).push(...cards);
  }
  async shuffleStock(_deck: string, guard?: Guard) { await guard?.(); this.piles.stock.reverse(); }
  assertComplete() {
    const cards = [...this.main, ...this.drawn, ...Object.values(this.piles).flat()];
    assert.equal(cards.length, 52); assert.equal(new Set(cards.map(card => card.code)).size, 52);
  }
}
