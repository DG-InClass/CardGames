import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { deckGateway, type DeckGateway } from '../lib/deck-api';
import { RANKS, type Card, type Rank } from '../lib/cards';
import { askFish, logEvent, publicHand, removeFishPlayer, startFish, type FishGame, type RoomSummary, type RoomView } from '../lib/go-fish';

export const DISCONNECT_MS = 45_000;
export const ROOM_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_ROOMS = 100;
export class RoomError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type Seat = { id: string; token: string; seen: number };
type Operation = { type: 'move'; pile: string; cards: Card[] } | { type: 'recycle'; cards: Card[]; piles: string[] };
type Room = {
  code: string; game: FishGame; deck?: string; version: number;
  seats: Seat[]; pending: Operation[]; busy: boolean; syncError: boolean; expiresAt: number;
};
export type FishAction = { type: 'start' } | { type: 'ask'; opponent: string; rank: Rank };

function shuffle(cards: Card[]) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export class RoomStore {
  private rooms = new Map<string, Room>();
  constructor(private api: DeckGateway = deckGateway, private now = Date.now) {}

  list(): RoomSummary[] {
    return [...this.rooms.values()].filter(room => room.game.status === 'waiting' && room.game.players.length < 4 && room.expiresAt > this.now())
      .map(room => ({ code: room.code, host: room.game.players[0]?.name ?? 'Open table', playerCount: room.game.players.length }));
  }

  private name(input: unknown) {
    if (typeof input !== 'string' || !input.trim() || input.trim().length > 24 || /[\p{Cc}\p{Cf}]/u.test(input)) {
      throw new RoomError('Enter a name between 1 and 24 characters.');
    }
    return input.trim();
  }

  create(input: unknown) {
    const name = this.name(input);
    if (this.rooms.size >= MAX_ROOMS) throw new RoomError('All tables are busy. Try again later.', 503);
    let code: string;
    do { code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); } while (this.rooms.has(code));
    const id = randomUUID();
    const seat = { id, token: randomUUID(), seen: this.now() };
    const room: Room = {
      code, version: 0, seats: [seat], pending: [], busy: false, syncError: false,
      expiresAt: this.now() + ROOM_LIFETIME_MS,
      game: { status: 'waiting', players: [{ id, name, hand: [], books: [] }], stock: [], host: id, turn: null, log: [`${name} opened the table.`], winners: [] },
    };
    this.rooms.set(code, room);
    return { token: seat.token, room: this.view(room, id) };
  }

  join(code: string, input: unknown) {
    const room = this.room(code);
    const name = this.name(input);
    if (room.busy || room.game.status !== 'waiting') throw new RoomError('This game has already started.', 409);
    if (room.game.players.length >= 4) throw new RoomError('This table is full (four players maximum).', 409);
    if (room.game.players.some(player => player.name.toLowerCase() === name.toLowerCase())) throw new RoomError('That name is taken at this table. Choose another.');
    const seat = { id: randomUUID(), token: randomUUID(), seen: this.now() };
    room.seats.push(seat);
    room.game.players.push({ id: seat.id, name, hand: [], books: [] });
    room.version++;
    logEvent(room.game, `${name} joined the table.`);
    return { token: seat.token, room: this.view(room, seat.id) };
  }

  private room(code: string) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room || room.expiresAt <= this.now()) throw new RoomError('This table has expired. Join or create another.', 404);
    return room;
  }

  private seat(room: Room, token: string) {
    const seat = room.seats.find(person => person.token === token);
    if (!seat || this.now() - seat.seen > DISCONNECT_MS) throw new RoomError('Your seat expired. Your cards are being returned to the deck.', 401);
    seat.seen = this.now();
    return seat;
  }

  get(code: string, token: string) {
    const room = this.room(code);
    return this.view(room, this.seat(room, token).id);
  }

  private view(room: Room, id: string): RoomView {
    return {
      code: room.code, version: room.version, status: room.game.status, host: room.game.host, turn: room.game.turn,
      players: room.game.players.map(player => ({
        id: player.id, name: player.name, cardCount: player.hand.length,
        books: player.books.map(book => book[0].value),
        reconnecting: this.now() - (room.seats.find(seat => seat.id === player.id)?.seen ?? 0) > 15_000,
      })),
      you: id, hand: publicHand(room.game, id), stockCount: room.game.stock.length,
      log: [...room.game.log], winners: [...room.game.winners], syncing: room.busy || room.pending.length > 0,
      syncError: room.syncError, expiresAt: room.expiresAt,
    };
  }

  private queueChanges(room: Room, previous: FishGame, returned: Card[] = []) {
    if (!room.deck) return;
    const owners = new Map<string, string>();
    for (const player of previous.players) {
      player.hand.forEach(card => owners.set(card.code, `hand_${player.id}`));
      player.books.flat().forEach(card => owners.set(card.code, `books_${player.id}`));
    }
    if (returned.length) room.pending.push({
      type: 'recycle', cards: returned,
      piles: [...new Set(returned.map(card => owners.get(card.code)).filter((pile): pile is string => Boolean(pile)))],
    });
    for (const player of room.game.players) {
      for (const [pile, cards] of [[`hand_${player.id}`, player.hand], [`books_${player.id}`, player.books.flat()]] as const) {
        const moved = cards.filter(card => owners.get(card.code) !== pile);
        if (moved.length) room.pending.push({ type: 'move', pile, cards: moved });
      }
    }
  }

  private async flush(room: Room) {
    room.busy = true;
    try {
      while (room.pending.length && room.deck) {
        const operation = room.pending[0];
        if (operation.type === 'recycle') await this.api.recycle(room.deck, operation.cards, operation.piles);
        else await this.api.move(room.deck, operation.pile, operation.cards);
        room.pending.shift();
      }
      room.syncError = false;
    } catch {
      // Retain the operation and pause new moves. The sweeper retries it.
      // Cards and scores remain authoritative here, never in browser state.
      room.syncError = true;
    } finally { room.busy = false; }
  }

  async action(code: string, token: string, version: number, action: FishAction) {
    const room = this.room(code);
    const seat = this.seat(room, token);
    if (room.busy || room.pending.length) throw new RoomError('The deck is syncing. Please wait a moment.', 409);
    if (room.version !== version) throw new RoomError('The table changed. Review the latest cards and try again.', 409);
    if (action.type === 'start') {
      if (seat.id !== room.game.host) throw new RoomError('Only the host can deal.', 403);
      if (room.game.status !== 'waiting' || room.game.players.length < 2) throw new RoomError('Wait for at least two players.');
      room.busy = true;
      try {
        const deck = await this.api.create();
        room.deck = deck.id;
        const previous = structuredClone(room.game);
        startFish(room.game, deck.cards);
        room.version++;
        this.queueChanges(room, previous);
      } finally { room.busy = false; }
    } else {
      if (!RANKS.includes(action.rank)) throw new RoomError('Choose a valid rank.');
      const previous = structuredClone(room.game);
      try { askFish(room.game, seat.id, action.opponent, action.rank); }
      catch (error) { throw new RoomError((error as Error).message); }
      room.version++;
      this.queueChanges(room, previous);
    }
    await this.flush(room);
    return this.view(room, seat.id);
  }

  async leave(code: string, token: string) {
    const room = this.room(code);
    const seat = this.seat(room, token);
    // Expire immediately even if an external operation is still running.
    seat.seen = -Infinity;
    await this.sweep();
  }

  async sweep() {
    await Promise.all([...this.rooms.values()].map(async room => {
      if (room.busy) return;
      // Expiring a room also returns every player's hand and books.
      const expired = room.expiresAt <= this.now();
      for (const seat of [...room.seats]) {
        if (!expired && this.now() - seat.seen <= DISCONNECT_MS) continue;
        const previous = structuredClone(room.game);
        const returned = removeFishPlayer(room.game, seat.id, shuffle);
        room.seats = room.seats.filter(person => person.id !== seat.id);
        room.version++;
        this.queueChanges(room, previous, returned);
      }
      if (room.pending.length) await this.flush(room);
      if (!room.seats.length && !room.pending.length) this.rooms.delete(room.code);
    }));
  }
}

// One store per Node process, shared by requests and retained across Vite HMR.
const globals = globalThis as typeof globalThis & { cardRooms?: RoomStore; cardRoomsTimer?: ReturnType<typeof setInterval> };
export const rooms = globals.cardRooms ??= new RoomStore();
globals.cardRoomsTimer ??= setInterval(() => { void rooms.sweep().catch(console.error); }, 5000).unref();
