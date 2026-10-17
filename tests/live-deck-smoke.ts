// Manual integration check: contacts the real Deck of Cards API.
// Redis remains a test double; this does not validate deployed credentials.
import assert from 'node:assert/strict';
import { RoomStore } from '../src/server/rooms';
import { deckGateway } from '../src/lib/deck-api';
import { MemoryRepository } from './helpers';

const repository = new MemoryRepository();
const fresh = () => new RoomStore(repository, deckGateway, () => 1_000_000);
const host = await fresh().create('Smoke Host');
const code = host.room.code;
const guest = await fresh().join(code, 'Smoke Guest');
const third = await fresh().join(code, 'Smoke Third');
let view = await fresh().action(code, host.token, 2, { type: 'start' });
assert.equal(view.syncing, false, 'Initial deal completed');
assert.equal(view.players.reduce((count, player) => count + player.cardCount + player.books.length * 4, 0) + view.stockCount, 52);
view = await fresh().action(code, host.token, view.version, { type: 'ask', opponent: guest.room.you, rank: view.hand[0].value });
assert.equal(view.syncing, false, 'Ask completed');
await fresh().leave(code, guest.token);
view = await fresh().get(code, host.token);
assert.equal(view.syncing, false, 'Card returns completed');
assert.equal(view.players.length, 2);
const deckId = (await repository.read(code))!.deck!;
await fresh().leave(code, third.token);
await fresh().leave(code, host.token);
assert.equal(await repository.read(code), null);
const stock = await deckGateway.pile(deckId, 'stock');
assert.equal(stock.cards.length, 52);
assert.equal(new Set(stock.cards.map(card => card.code)).size, 52);
console.log('Live Deck API smoke passed: three seats, deal, ask, fresh instances, all departures, 52 unique cards back in stock.');
