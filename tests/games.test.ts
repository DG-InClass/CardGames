import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RANKS, SUITS, rankLabel, type Card } from '../src/lib/cards';
import { dealSolitaire, drawStock, hasWon, moveCards, type SolitaireState } from '../src/lib/solitaire';
import { askFish, removeFishPlayer, startFish, type FishGame } from '../src/lib/go-fish';
import { DISCONNECT_MS, ROOM_LIFETIME_MS, RoomStore } from '../src/server/rooms';
import type { DeckGateway } from '../src/lib/deck-api';

const deck = SUITS.flatMap(suit => RANKS.map(value => ({ code: `${value === '10' ? '0' : rankLabel(value)}${suit[0]}`, suit, value, image: '' })));
const card = (code: string) => structuredClone(deck.find(card => card.code === code)!);
const emptySolitaire = (): SolitaireState => ({ stock: [], waste: [], tableau: Array.from({ length: 7 }, () => []), foundations: [[], [], [], []], moves: 0 });
const fish = (count = 2): FishGame => ({ status: 'waiting', host: 'p0', turn: null, stock: [], log: [], winners: [], players: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `Player ${index}`, hand: [], books: [] })) });
const totalCards = (game: FishGame) => [...game.stock, ...game.players.flatMap(player => [...player.hand, ...player.books.flat()])];
const fakeApi = (): DeckGateway => ({ create: async () => ({ id: 'test-deck', cards: structuredClone(deck) }), move: async () => {}, recycle: async () => {} });

test('Solitaire deals 52 unique cards with only the seven top cards exposed', () => {
  const game = dealSolitaire(deck);
  assert.deepEqual(game.tableau.map(pile => pile.length), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(game.tableau.flat().filter(card => card.faceUp).length, 7);
  assert.equal(game.stock.length, 24);
  assert.throws(() => dealSolitaire(deck.slice(1)), /incomplete deck/);
});

test('Stock recycling retains draw order and never mutates undo snapshots', () => {
  let game = dealSolitaire(deck);
  const original = structuredClone(game);
  const first = game.stock[0];
  while (game.stock.length) game = drawStock(game);
  game = drawStock(game);
  assert.equal(game.stock[0].code, first.code);
  assert.deepEqual(dealSolitaire(deck), original);
  assert.equal(drawStock(game).waste[0].code, first.code);
});

test('Solitaire enforces alternating colors, kings in empty columns, and ascending suit foundations', () => {
  const game = emptySolitaire();
  game.waste = [card('QH')];
  game.tableau[0] = [{ ...card('KS'), faceUp: true }];
  game.tableau[1] = [{ ...card('KD'), faceUp: true }];
  assert.ok(moveCards(game, { kind: 'waste' }, { kind: 'tableau', column: 0 }));
  assert.equal(moveCards(game, { kind: 'waste' }, { kind: 'tableau', column: 1 }), null);
  assert.equal(moveCards(game, { kind: 'waste' }, { kind: 'tableau', column: 2 }), null);
  game.waste = [card('AS')];
  assert.ok(moveCards(game, { kind: 'waste' }, { kind: 'foundation', column: 0 }));
  assert.equal(moveCards(game, { kind: 'waste' }, { kind: 'foundation', column: 1 }), null);
  game.waste = [card('2S')];
  assert.equal(moveCards(game, { kind: 'waste' }, { kind: 'foundation', column: 0 }), null);
});

test('Moving a tableau run exposes a hidden card and preserves all cards', () => {
  const game = emptySolitaire();
  game.tableau[0] = [{ ...card('AS'), faceUp: false }, { ...card('QH'), faceUp: true }, { ...card('JC'), faceUp: true }];
  game.tableau[1] = [{ ...card('KS'), faceUp: true }];
  assert.equal(moveCards(game, { kind: 'tableau', column: 0, index: 0 }, { kind: 'tableau', column: 2 }), null);
  const next = moveCards(game, { kind: 'tableau', column: 0, index: 1 }, { kind: 'tableau', column: 1 })!;
  assert.equal(next.tableau[0][0].faceUp, true);
  assert.deepEqual(next.tableau[1].map(card => card.code), ['KS', 'QH', 'JC']);
  assert.equal(game.tableau[0][0].faceUp, false);
  next.foundations = SUITS.map(suit => deck.filter(card => card.suit === suit));
  assert.ok(hasWon(next));
});

test('Go Fish deals seven each for two players and five each for three or four', () => {
  for (const count of [2, 3, 4]) {
    const game = fish(count);
    startFish(game, deck);
    assert.equal(game.players[0].hand.length, count === 2 ? 7 : 5);
    assert.equal(totalCards(game).length, 52);
    assert.equal(new Set(totalCards(game).map(card => card.code)).size, 52);
  }
});

test('Go Fish rejects out-of-turn requests, absent ranks, and self requests', () => {
  const game = fish(); startFish(game, deck);
  assert.throws(() => askFish(game, 'p1', 'p0', 'ACE'), /Wait for your turn/);
  assert.throws(() => askFish(game, 'p0', 'p0', 'ACE'), /another player/);
  assert.throws(() => askFish(game, 'p0', 'p1', '2'), /rank in your hand/);
});

test('A successful request transfers all matches, collects a book, and retains the turn', () => {
  const game = fish(); game.status = 'playing'; game.turn = 'p0';
  game.players[0].hand = ['AS', 'AH', '2S'].map(card);
  game.players[1].hand = ['AC', 'AD', '3S'].map(card);
  askFish(game, 'p0', 'p1', 'ACE');
  assert.equal(game.players[0].books.length, 1);
  assert.deepEqual(game.players[1].hand.map(card => card.code), ['3S']);
  assert.equal(game.turn, 'p0');
});

test('Fishing gives another turn only for the requested rank', () => {
  for (const drawn of ['AH', '4S']) {
    const game = fish(); game.status = 'playing'; game.turn = 'p0';
    game.players[0].hand = [card('AS')]; game.players[1].hand = [card('3S')]; game.stock = [card(drawn)];
    askFish(game, 'p0', 'p1', 'ACE');
    assert.equal(game.turn, drawn === 'AH' ? 'p0' : 'p1');
    assert.equal(game.players[0].hand.length, 2);
  }
});

test('The last book ends a game, and equal scores share the win', () => {
  const game = fish(); game.status = 'playing'; game.turn = 'p0';
  game.players[0].hand = ['AS', 'AH', 'AC'].map(card);
  game.players[1].hand = [card('AD')];
  game.players[1].books = [['2S', '2H', '2C', '2D'].map(card)];
  askFish(game, 'p0', 'p1', 'ACE');
  assert.equal(game.status, 'finished');
  assert.equal(game.turn, null);
  assert.deepEqual(game.winners, ['Player 0', 'Player 1']);
});

test('Leaving returns the hand AND books, hands off host/turn, and keeps the remaining game playable', () => {
  const game = fish(3); game.status = 'playing'; game.turn = 'p0';
  game.players[0].hand = [card('2S')]; game.players[0].books = [['AS', 'AH', 'AC', 'AD'].map(card)];
  game.players[1].hand = [card('3S')]; game.players[2].hand = [card('4S')];
  const returned = removeFishPlayer(game, 'p0', cards => cards);
  assert.equal(returned.length, 5); assert.equal(game.stock.length, 5);
  assert.equal(game.host, 'p1'); assert.equal(game.turn, 'p1'); assert.equal(game.status, 'playing');
  removeFishPlayer(game, 'p1', cards => cards);
  assert.equal(game.status, 'cancelled');
});

test('Lobby enforces capacity, unique names, membership, and host-only dealing', async () => {
  const store = new RoomStore(fakeApi()); const host = store.create('Host'); const code = host.room.code;
  const guest = store.join(code, 'Guest'); store.join(code, 'Third'); store.join(code, 'Fourth');
  assert.throws(() => store.join(code, 'Fifth'), /full/);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.get(code, 'bad-token'), /expired/);
  await assert.rejects(store.action(code, guest.token, 3, { type: 'start' }), /Only the host/);
  const other = new RoomStore(fakeApi()); const room = other.create('Name');
  assert.throws(() => other.join(room.room.code, 'name'), /taken/);
});

test('Room responses never expose another hand, the deck ID, or seat tokens; stale actions cannot replay', async () => {
  const store = new RoomStore(fakeApi()); const host = store.create('Host'); const code = host.room.code;
  const guest = store.join(code, 'Guest');
  const view = await store.action(code, host.token, 1, { type: 'start' });
  const text = JSON.stringify(view);
  assert.equal(view.hand.length, 7);
  assert.ok(!text.includes(host.token) && !text.includes(guest.token) && !text.includes('test-deck'));
  assert.ok(view.players.every(player => !('hand' in player)));
  await assert.rejects(store.action(code, host.token, 1, { type: 'start' }), /table changed/);
  assert.throws(() => store.join(code, 'Late'), /already started/);
});

test('Heartbeat grace allows reconnects, then returns expired players cards through the API', async () => {
  let now = 0; const returned: Card[][] = []; const gateway = fakeApi();
  gateway.recycle = async (_deck, cards, piles) => {
    returned.push(cards);
    assert.equal(piles.length, 1);
    assert.ok(piles[0].startsWith('hand_'));
  };
  const store = new RoomStore(gateway, () => now); const host = store.create('Host'); const code = host.room.code;
  const guest = store.join(code, 'Guest'); const third = store.join(code, 'Third');
  await store.action(code, host.token, 2, { type: 'start' });
  now = 30_000; store.get(code, host.token); store.get(code, third.token);
  now = DISCONNECT_MS + 1; await store.sweep();
  assert.throws(() => store.get(code, guest.token), /expired/);
  const view = store.get(code, host.token);
  assert.equal(view.players.length, 2); assert.equal(view.stockCount, 42);
  assert.equal(returned.flat().length, 5); assert.equal(view.status, 'playing');
});

test('API failures pause moves, retry pile updates, and preserve all 52 cards', async () => {
  let fail = true; let moves = 0; const gateway = fakeApi();
  gateway.move = async () => { moves++; if (fail) throw new Error('network failure'); };
  const store = new RoomStore(gateway); const host = store.create('Host'); const code = host.room.code;
  store.join(code, 'Guest');
  const view = await store.action(code, host.token, 1, { type: 'start' });
  assert.ok(view.syncError && view.syncing);
  await assert.rejects(store.action(code, host.token, view.version, { type: 'start' }), /syncing/);
  fail = false; await store.sweep();
  const recovered = store.get(code, host.token);
  assert.equal(recovered.syncing, false); assert.equal(recovered.syncError, false);
  assert.equal(recovered.stockCount + recovered.players.reduce((sum, player) => sum + player.cardCount + player.books.length * 4, 0), 52);
  assert.equal(moves, 3);
});

test('Rooms expire and are removed after their final player leaves', async () => {
  let now = 0; const store = new RoomStore(fakeApi(), () => now);
  const host = store.create('Host');
  now = ROOM_LIFETIME_MS + 1; await store.sweep();
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.get(host.room.code, host.token), /expired/);
  const next = store.create('Next'); await store.leave(next.room.code, next.token);
  assert.deepEqual(store.list(), []);
});

test('Complete simulated games conserve cards and terminate with thirteen books', () => {
  let seed = 419;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (const count of [2, 3, 4]) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const game = fish(count); startFish(game, shuffled);
    let turns = 0;
    while (game.status === 'playing' && turns++ < 1000) {
      const player = game.players.find(player => player.id === game.turn)!;
      const opponents = game.players.filter(other => other.id !== player.id && other.hand.length);
      assert.ok(opponents.length > 0, 'Every active turn has an opponent to ask');
      askFish(game, player.id, opponents[Math.floor(random() * opponents.length)].id, player.hand[Math.floor(random() * player.hand.length)].value);
      assert.equal(totalCards(game).length, 52);
      assert.equal(new Set(totalCards(game).map(card => card.code)).size, 52);
    }
    assert.equal(game.status, 'finished');
    assert.equal(game.players.reduce((sum, player) => sum + player.books.length, 0), 13);
  }
});
