import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { deckGateway, STOCK_PILE, type DeckGateway, type Guard } from '../lib/deck-api';
import { assertDeck, RANKS, sortHand, type Card } from '../lib/cards';
import { askFish, removeFishPlayers, startFish, type FishGame, type RoomSummary, type RoomView } from '../lib/go-fish';
import type { FishAction, GoFishService } from './go-fish-service';
import { StorageError, type RoomRepository } from './storage/room-repository';
import { DISCONNECT_MS, ROOM_LIFETIME_MS, RoomError, type CardOperation, type RoomRecord } from './room-types';

export { DISCONNECT_MS, ROOM_LIFETIME_MS, RoomError } from './room-types';
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const handPile = (id: string) => `hand_${id}`;
const booksPile = (id: string) => `books_${id}`;

function emptyGame(room: RoomRecord): FishGame {
  return {
    status: room.status, host: room.host, turn: room.turn, stock: [], log: [...room.log], winners: [...room.winners],
    players: room.players.map(player => ({ id: player.id, name: player.name, hand: [], books: [] })),
  };
}
function locations(game: FishGame) {
  const piles = new Map<string, Card[]>([[STOCK_PILE, game.stock]]);
  for (const player of game.players) {
    piles.set(handPile(player.id), player.hand);
    piles.set(booksPile(player.id), player.books.flat());
  }
  return piles;
}

export class RoomStore implements GoFishService {
  constructor(
    private repository: RoomRepository,
    private api: DeckGateway = deckGateway,
    private now = Date.now,
  ) {}

  async list(): Promise<RoomSummary[]> {
    return (await this.repository.list(this.now()))
      .filter(room => room.status === 'waiting' && room.players.length < 4 && room.expiresAt > this.now())
      .map(room => ({ code: room.code, host: room.players.find(player => player.id === room.host)?.name ?? 'Open table', playerCount: room.players.length }));
  }

  private name(input: unknown) {
    if (typeof input !== 'string' || !input.trim() || input.trim().length > 24 || /[\p{Cc}\p{Cf}]/u.test(input)) {
      throw new RoomError('Enter a name between 1 and 24 characters.');
    }
    return input.trim();
  }

  async create(input: unknown) {
    const name = this.name(input);
    // Reclaim one abandoned room before capacity checks; never wait for a timer.
    await this.sweep(1);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomBytes(3).toString('hex').toUpperCase();
      const id = randomUUID(); const token = randomUUID();
      const room: RoomRecord = {
        code, version: 0, pending: [], syncError: false, expiresAt: this.now() + ROOM_LIFETIME_MS,
        status: 'waiting', players: [{ id, name, tokenHash: tokenHash(token), books: [] }],
        host: id, turn: null, log: [`${name} opened the table.`], winners: [],
      };
      if (await this.repository.create(room, this.now())) return { token, room: await this.view(room, id) };
    }
    throw new RoomError('Could not allocate a table code. Please try again.', 503);
  }

  private async read(code: string) {
    const room = await this.repository.read(code.toUpperCase());
    if (!room) throw new RoomError('This table has expired. Join or create another.', 404);
    return room;
  }
  private member(room: RoomRecord, token: string) {
    const seat = room.players.find(player => player.tokenHash === tokenHash(token));
    if (!seat) throw new RoomError('Your seat expired. Your cards are being returned to the deck.', 401);
    return seat;
  }
  private async heartbeat(room: RoomRecord, token: string) {
    const seat = this.member(room, token);
    if (!await this.repository.heartbeat(room.code, seat.id, this.now())) {
      await this.maintain(room.code).catch(() => {});
      throw new RoomError('Your seat expired. Your cards are being returned to the deck.', 401);
    }
    return seat;
  }

  private async locked<T>(code: string, work: (room: RoomRecord, owner: string, guard: Guard) => Promise<T>, requestDeadline = Infinity): Promise<T> {
    code = code.toUpperCase();
    const owner = randomUUID();
    if (!await this.repository.acquire(code, owner)) throw new RoomError('The table is updating. Please try again in a moment.', 409);
    const deadline = Math.min(Date.now() + 30_000, requestDeadline);
    const guard: Guard = async () => {
      if (Date.now() >= deadline) throw new RoomError('This move will continue on the next table update.', 409);
      if (!await this.repository.owns(code, owner)) throw new RoomError('The table lock expired. Refresh before making another move.', 409);
    };
    try { return await work(await this.read(code), owner, guard); }
    finally { await this.repository.release(code, owner).catch(() => {}); }
  }

  async join(code: string, input: unknown) {
    const name = this.name(input);
    return this.locked(code, async (room, owner, guard) => {
      await this.cleanup(room, owner, guard);
      this.checkExpiry(room);
      if (room.pending.length || room.status !== 'waiting') throw new RoomError('This game has already started.', 409);
      if (room.players.length >= 4) throw new RoomError('This table is full (four players maximum).', 409);
      if (room.players.some(player => player.name.toLowerCase() === name.toLowerCase())) throw new RoomError('That name is taken at this table. Choose another.');
      const id = randomUUID(); const token = randomUUID();
      room.players.push({ id, name, tokenHash: tokenHash(token), books: [] });
      room.log = [`${name} joined the table.`, ...room.log].slice(0, 16);
      room.version++;
      await this.repository.save(room, owner, this.now());
      return { token, room: await this.view(room, id) };
    });
  }

  private checkExpiry(room: RoomRecord) {
    if (room.expiresAt <= this.now() || !room.players.length) throw new RoomError('This table has expired. Join or create another.', 404);
  }

  async get(code: string, token: string) {
    await this.heartbeat(await this.read(code), token);
    // Read under the same lock as moves so metadata and remote piles agree.
    return this.locked(code, async (room, owner, guard) => {
      await this.cleanup(room, owner, guard);
      this.checkExpiry(room);
      return this.view(room, this.member(room, token).id);
    });
  }

  private async view(room: RoomRecord, id: string): Promise<RoomView> {
    const presence = await this.repository.presence(room.code);
    // Never expose a partially applied set of piles while a transaction recovers.
    const stock = room.deck && !room.pending.length ? await this.api.pile(room.deck, STOCK_PILE) : null;
    const hand = stock?.counts[handPile(id)] ? await this.api.pile(room.deck!, handPile(id)) : null;
    return {
      code: room.code, version: room.version, status: room.status, host: room.host, turn: room.turn,
      players: room.players.map(player => ({ id: player.id, name: player.name,
        cardCount: stock?.counts[handPile(player.id)] ?? 0, books: [...player.books],
        reconnecting: this.now() - (presence[player.id] ?? 0) > 15_000,
      })),
      you: id, hand: sortHand(hand?.cards ?? []), stockCount: stock?.counts[STOCK_PILE] ?? 0,
      log: [...room.log], winners: [...room.winners], syncing: room.pending.length > 0,
      syncError: room.syncError, expiresAt: room.expiresAt,
    };
  }

  private async snapshot(room: RoomRecord): Promise<FishGame> {
    const game = emptyGame(room);
    if (!room.deck) return game;
    const stock = await this.api.pile(room.deck, STOCK_PILE);
    game.stock = stock.cards;
    await Promise.all(game.players.map(async player => {
      player.hand = stock.counts[handPile(player.id)] ? (await this.api.pile(room.deck!, handPile(player.id))).cards : [];
      const books = stock.counts[booksPile(player.id)] ? (await this.api.pile(room.deck!, booksPile(player.id))).cards : [];
      player.books = RANKS.map(rank => books.filter(card => card.value === rank)).filter(book => book.length);
      if (player.books.some(book => book.length !== 4)) throw new RoomError('The card service returned an incomplete book. The table is paused.', 503);
    }));
    // The stock pile + every hand and book must partition a standard deck.
    assertDeck([...game.stock, ...game.players.flatMap(player => [...player.hand, ...player.books.flat()])]);
    return game;
  }

  private async install(room: RoomRecord, previous: FishGame, next: FishGame, owner: string, returned: Card[] = []) {
    const operations: CardOperation[] = [];
    const owners = new Map<string, string>();
    for (const [pile, cards] of locations(previous)) cards.forEach(card => owners.set(card.code, pile));
    if (returned.length) {
      const codes = returned.map(card => card.code);
      for (const pile of new Set(codes.map(code => owners.get(code)!))) {
        operations.push({ type: 'return', pile, codes: codes.filter(code => owners.get(code) === pile) });
      }
      operations.push({ type: 'restore-stock', codes });
    }
    for (const [pile, cards] of locations(next)) {
      // restore-stock already puts departed players' cards into the stock pile.
      const codes = cards.filter(card => owners.get(card.code) !== pile && !(pile === STOCK_PILE && returned.some(value => value.code === card.code))).map(card => card.code);
      if (codes.length) operations.push({ type: 'move', pile, codes });
    }
    if (returned.length && next.stock.length) operations.push({ type: 'shuffle' });
    room.status = next.status; room.host = next.host; room.turn = next.turn;
    room.log = next.log; room.winners = next.winners;
    room.players = next.players.map(player => ({ ...room.players.find(person => person.id === player.id)!, books: player.books.map(book => book[0].value) }));
    room.pending = operations; room.syncError = false; room.version++;
    // Save the intended move BEFORE touching any remote pile. A new function
    // invocation can replay these idempotent operations after a crash.
    await this.repository.save(room, owner, this.now());
  }

  private async flush(room: RoomRecord, owner: string, guard: Guard) {
    try {
      while (room.pending.length && room.deck) {
        await guard();
        const operation = room.pending[0];
        if (operation.type === 'move') await this.api.move(room.deck, operation.pile, operation.codes, guard);
        else if (operation.type === 'return') await this.api.returnPile(room.deck, operation.pile, operation.codes, guard);
        else if (operation.type === 'restore-stock') await this.api.restoreStock(room.deck, operation.codes, guard);
        else await this.api.shuffleStock(room.deck, guard);
        const next = { ...room, pending: room.pending.slice(1), syncError: false };
        await this.repository.save(next, owner, this.now());
        Object.assign(room, next);
      }
    } catch {
      room.syncError = true;
      await this.repository.save(room, owner, this.now());
    }
  }

  async action(code: string, token: string, version: number, action: FishAction) {
    await this.heartbeat(await this.read(code), token);
    return this.locked(code, async (room, owner, guard) => {
      await this.cleanup(room, owner, guard);
      this.checkExpiry(room);
      const seat = this.member(room, token);
      if (room.pending.length) throw new RoomError('The deck is syncing. Please wait a moment.', 409);
      if (room.version !== version) throw new RoomError('The table changed. Review the latest cards and try again.', 409);
      const previous = await this.snapshot(room);
      const next = structuredClone(previous);
      if (action.type === 'start') {
        if (seat.id !== room.host) throw new RoomError('Only the host can deal.', 403);
        if (room.status !== 'waiting' || room.players.length < 2) throw new RoomError('Wait for at least two players.');
        const deck = await this.api.create(guard);
        assertDeck(deck.cards);
        room.deck = deck.id;
        startFish(next, deck.cards);
      } else {
        if (!RANKS.includes(action.rank)) throw new RoomError('Choose a valid rank.');
        try { askFish(next, seat.id, action.opponent, action.rank); }
        catch (error) { throw new RoomError((error as Error).message); }
      }
      await this.install(room, previous, next, owner);
      await this.flush(room, owner, guard);
      return this.view(room, seat.id);
    });
  }

  async leave(code: string, token: string) {
    await this.heartbeat(await this.read(code), token);
    await this.locked(code, async (room, owner, guard) => {
      const seat = this.member(room, token);
      await this.flush(room, owner, guard);
      if (room.pending.length) throw new RoomError('The deck is recovering. Try leaving again shortly.', 503);
      await this.drop(room, [seat.id], owner, guard);
    });
  }

  private async drop(room: RoomRecord, ids: string[], owner: string, guard: Guard) {
    const previous = await this.snapshot(room);
    const next = structuredClone(previous);
    // Return all departing players together before refilling anyone's hand.
    // This prevents an expired player's cards from being dealt to another
    // departing player halfway through cleanup.
    const returned = removeFishPlayers(next, ids, cards => cards);
    await this.install(room, previous, next, owner, returned);
    await this.flush(room, owner, guard);
    if (!room.players.length && !room.pending.length) await this.repository.remove(room.code, owner);
  }

  private async cleanup(room: RoomRecord, owner: string, guard: Guard) {
    await this.flush(room, owner, guard);
    if (room.pending.length) return;
    const presence = await this.repository.presence(room.code);
    const ids = room.players.filter(player => room.expiresAt <= this.now() || this.now() - (presence[player.id] ?? 0) > DISCONNECT_MS).map(player => player.id);
    if (ids.length) await this.drop(room, ids, owner, guard);
    else if (!room.players.length) await this.repository.remove(room.code, owner);
  }

  private async maintain(code: string, deadline = Infinity) {
    return this.locked(code, (room, owner, guard) => this.cleanup(room, owner, guard), deadline);
  }

  async sweep(limit = 100) {
    const due = (await this.repository.due(this.now())).slice(0, limit);
    const deadline = Date.now() + 25_000;
    let processed = 0;
    let failed = 0;
    // Bounded invocation; unfinished rooms remain indexed for the next request.
    for (const code of due) {
      if (Date.now() >= deadline) break;
      try {
        const exists = await this.repository.read(code);
        if (exists) await this.maintain(code, deadline);
        else {
          const owner = randomUUID();
          if (await this.repository.acquire(code, owner)) {
            try { await this.repository.remove(code, owner); }
            finally { await this.repository.release(code, owner); }
          }
        }
        processed++;
      } catch (error) {
        // An unavailable/expired external deck must not block other rooms.
        if (!(error instanceof RoomError && error.status === 409) && !(error instanceof StorageError && error.code === 'conflict')) failed++;
      }
    }
    return { processed, ...(failed ? { failed } : {}) };
  }
}
