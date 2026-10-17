import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckGateway } from '../src/lib/deck-api';
import { deck } from './helpers';
import type { Card } from '../src/lib/cards';

test('Returns recover lost draw and pile-add responses without duplicating cards', async () => {
  const originalFetch = globalThis.fetch;
  for (const loseAt of ['draw', 'add']) {
    const cards = deck.slice(0, 3);
    const codes = cards.map(card => card.code);
    const piles: Record<string, Card[]> = { hand: [cards[0]], books: cards.slice(1), stock: [] };
    let main: Card[] = []; let drawn: Card[] = []; let loseResponse = true;
    const calls: string[] = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input)); const path = url.pathname; calls.push(path);
      assert.equal(url.hostname, 'www.deckofcardsapi.com');
      assert.deepEqual(url.searchParams.get('cards')?.split(',') ?? codes, path.includes('/hand/') ? [codes[0]] : path.includes('/books/') ? codes.slice(1) : codes);
      const pileReturn = path.match(/pile\/(\w+)\/return/);
      if (pileReturn) {
        const name = pileReturn[1]; const selected = url.searchParams.get('cards')!.split(',');
        main.push(...piles[name].filter(card => selected.includes(card.code)));
        piles[name] = piles[name].filter(card => !selected.includes(card.code));
      } else if (path.endsWith('/return/')) { main.push(...drawn); drawn = []; }
      else if (path.endsWith('/draw/')) {
        assert.equal(main.length, 3); drawn = main; main = [];
        if (loseAt === 'draw' && loseResponse) { loseResponse = false; throw new Error('Response lost'); }
        return Response.json({ success: true, cards: drawn, remaining: 0 });
      } else if (path.endsWith('/stock/add/')) {
        piles.stock.push(...drawn); drawn = [];
        if (loseAt === 'add' && loseResponse) { loseResponse = false; throw new Error('Response lost'); }
      } else throw new Error(`Unexpected request: ${path}`);
      return Response.json({ success: true, remaining: main.length });
    };
    try {
      await deckGateway.returnPile('test', 'hand', [codes[0]]);
      await deckGateway.returnPile('test', 'books', codes.slice(1));
      await assert.rejects(deckGateway.restoreStock('test', codes), /Response lost/);
      await deckGateway.restoreStock('test', codes);
      assert.deepEqual(piles.hand, []); assert.deepEqual(piles.books, []);
      assert.deepEqual(piles.stock.map(card => card.code), codes);
      assert.equal(main.length + drawn.length, 0);
      assert.equal(calls.filter(path => path.endsWith('/pile/stock/return/')).length, 2);
    } finally { globalThis.fetch = originalFetch; }
  }
});

test('API pile listing preserves card order and normalizes counts; mutations check the lock', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ success: true, remaining: 0, piles: { stock: { cards: deck.slice(0, 3), remaining: '3' }, hand_a: { remaining: '7' } } }); };
  try {
    const snapshot = await deckGateway.pile('test', 'stock');
    assert.deepEqual(snapshot.cards, deck.slice(0, 3)); assert.deepEqual(snapshot.counts, { stock: 3, hand_a: 7 });
    await assert.rejects(deckGateway.move('test', 'hand_a', ['AS'], async () => { throw new Error('Lock lost'); }), /Lock lost/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
