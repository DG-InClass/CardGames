import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckGateway } from '../src/lib/deck-api';
import type { Card } from '../src/lib/cards';

test('Disconnect returns both named piles and safely recovers a lost draw response', async () => {
  const originalFetch = globalThis.fetch;
  const cards: Card[] = [
    { code: 'AS', value: 'ACE', suit: 'SPADES', image: '' },
    { code: 'AH', value: 'ACE', suit: 'HEARTS', image: '' },
    { code: 'AC', value: 'ACE', suit: 'CLUBS', image: '' },
  ];
  const piles: Record<string, Card[]> = { hand: [cards[0]], books: cards.slice(1) };
  let stock: Card[] = []; let drawn: Card[] = []; let loseResponse = true;
  const calls: string[] = [];
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname; calls.push(path);
    const pile = path.match(/pile\/(\w+)\/return/);
    if (pile) { stock.push(...piles[pile[1]]); piles[pile[1]] = []; }
    else if (path.endsWith('/return/')) { stock.push(...drawn); drawn = []; }
    else if (path.endsWith('/draw/')) {
      assert.equal(stock.length, 3);
      drawn = stock; stock = [];
      if (loseResponse) { loseResponse = false; throw new Error('Response lost after the draw succeeded'); }
      return Response.json({ success: true, cards: drawn, remaining: 0 });
    } else throw new Error(`Unexpected request: ${path}`);
    return Response.json({ success: true, remaining: stock.length });
  };
  try {
    await assert.rejects(deckGateway.recycle('test', cards, ['hand', 'books']), /Response lost/);
    await deckGateway.recycle('test', cards, ['hand', 'books']);
    assert.deepEqual(piles, { hand: [], books: [] });
    assert.equal(drawn.length, 3); assert.equal(new Set(drawn.map(card => card.code)).size, 3);
    assert.equal(calls.filter(path => path.endsWith('/pile/hand/return/')).length, 2);
    assert.equal(calls.filter(path => path.endsWith('/pile/books/return/')).length, 2);
  } finally { globalThis.fetch = originalFetch; }
});
