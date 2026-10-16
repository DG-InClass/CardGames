import { RANKS, sortHand, type Card, type Rank } from './cards';

export type FishPlayer = { id: string; name: string; hand: Card[]; books: Card[][] };
export type FishGame = {
  status: 'waiting' | 'playing' | 'finished' | 'cancelled';
  players: FishPlayer[];
  stock: Card[];
  turn: string | null;
  host: string;
  log: string[];
  winners: string[];
};
export type RoomView = {
  code: string; version: number; status: FishGame['status']; host: string; turn: string | null;
  players: { id: string; name: string; cardCount: number; books: Rank[]; reconnecting: boolean }[];
  you: string; hand: Card[]; stockCount: number; log: string[]; winners: string[];
  syncing: boolean; syncError: boolean; expiresAt: number;
};
export type RoomSummary = { code: string; host: string; playerCount: number };

export function logEvent(game: FishGame, message: string) {
  game.log = [message, ...game.log].slice(0, 16);
}

function collectBooks(game: FishGame, player: FishPlayer) {
  for (const rank of RANKS) {
    const cards = player.hand.filter(card => card.value === rank);
    if (cards.length === 4) {
      player.books.push(cards);
      player.hand = player.hand.filter(card => card.value !== rank);
      logEvent(game, `${player.name} collected a book of ${rank.toLowerCase()}s.`);
    }
  }
}

function refill(game: FishGame, player: FishPlayer) {
  while (!player.hand.length && game.stock.length) {
    player.hand.push(...game.stock.splice(0, Math.min(5, game.stock.length)));
    collectBooks(game, player);
  }
}

function finishOrAdvance(game: FishGame, preferredIndex: number) {
  if (!game.stock.length && game.players.every(player => !player.hand.length)) {
    game.status = 'finished';
    game.turn = null;
    const best = Math.max(...game.players.map(player => player.books.length));
    game.winners = game.players.filter(player => player.books.length === best).map(player => player.name);
    logEvent(game, `${game.winners.join(' & ')} ${game.winners.length > 1 ? 'tie' : 'wins'} with ${best} books!`);
    return;
  }
  for (let step = 0; step < game.players.length; step++) {
    const player = game.players[(preferredIndex + step) % game.players.length];
    refill(game, player);
    if (player.hand.length) { game.turn = player.id; return; }
  }
  // Refill can consume the last cards and immediately complete a book.
  if (!game.stock.length) finishOrAdvance(game, 0);
}

export function startFish(game: FishGame, cards: Card[]) {
  if (game.status !== 'waiting' || game.players.length < 2 || game.players.length > 4) {
    throw new Error('Start with two to four players.');
  }
  game.stock = [...cards];
  const count = game.players.length === 2 ? 7 : 5;
  for (let i = 0; i < count; i++) for (const player of game.players) player.hand.push(game.stock.shift()!);
  game.status = 'playing';
  logEvent(game, 'Cards dealt. Collect four of a kind to make a book.');
  game.players.forEach(player => collectBooks(game, player));
  finishOrAdvance(game, 0);
}

export function askFish(game: FishGame, playerId: string, opponentId: string, rank: Rank) {
  if (game.status !== 'playing' || game.turn !== playerId) throw new Error('Wait for your turn.');
  const player = game.players.find(person => person.id === playerId)!;
  const opponent = game.players.find(person => person.id === opponentId);
  if (!opponent || opponent.id === player.id || !opponent.hand.length) throw new Error('Choose another player who has cards.');
  if (!player.hand.some(card => card.value === rank)) throw new Error('Ask for a rank in your hand.');
  const matches = opponent.hand.filter(card => card.value === rank);
  let again = matches.length > 0;
  if (again) {
    opponent.hand = opponent.hand.filter(card => card.value !== rank);
    player.hand.push(...matches);
    logEvent(game, `${opponent.name} gave ${player.name} ${matches.length} ${rank.toLowerCase()}${matches.length === 1 ? '' : 's'}. Ask again!`);
  } else {
    const drawn = game.stock.shift();
    if (drawn) { player.hand.push(drawn); again = drawn.value === rank; }
    logEvent(game, `${player.name} asked ${opponent.name} for ${rank.toLowerCase()}s. Go fish! ${drawn ? again ? 'A match — ask again!' : 'One card drawn.' : 'The pond is empty.'}`);
  }
  collectBooks(game, player);
  // An emptied hand refills immediately so every remaining player is askable.
  game.players.forEach(person => refill(game, person));
  const index = game.players.indexOf(player);
  finishOrAdvance(game, again ? index : (index + 1) % game.players.length);
}

export function removeFishPlayer(game: FishGame, id: string, shuffle: (cards: Card[]) => Card[]): Card[] {
  const index = game.players.findIndex(player => player.id === id);
  if (index === -1) return [];
  const player = game.players[index];
  const returned = [...player.hand, ...player.books.flat()];
  game.stock = shuffle([...game.stock, ...returned]);
  game.players.splice(index, 1);
  logEvent(game, `${player.name} left. ${returned.length} cards returned to the pond, including their books.`);
  if (game.host === id) game.host = game.players[0]?.id ?? '';
  if (game.status === 'playing') {
    if (game.players.length < 2) {
      game.status = 'cancelled';
      game.turn = null;
      logEvent(game, 'The game ended because fewer than two players remain.');
    } else {
      game.players.forEach(person => refill(game, person));
      const current = game.players.findIndex(person => person.id === game.turn);
      finishOrAdvance(game, current >= 0 ? current : index % game.players.length);
    }
  }
  return returned;
}

export function publicHand(game: FishGame, id: string) {
  return sortHand(game.players.find(player => player.id === id)?.hand ?? []);
}
