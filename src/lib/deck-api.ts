import { assertDeck, type Card } from './cards';

const BASE = 'https://www.deckofcardsapi.com/api/deck';
type DeckResponse = { success: boolean; error?: string; deck_id: string; cards?: Card[]; remaining: number };

async function request(path: string): Promise<DeckResponse> {
  const response = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error('The card service is unavailable. Please try again.');
  const data = await response.json() as DeckResponse;
  if (!data.success) throw new Error('The card service could not complete this move. Please try again.');
  return data;
}

export async function newDeck() {
  const data = await request('new/draw/?count=52');
  const cards = data.cards ?? [];
  assertDeck(cards);
  return { id: data.deck_id, cards };
}

export interface DeckGateway {
  create: typeof newDeck;
  move: (deck: string, pile: string, cards: Card[]) => Promise<void>;
  recycle: (deck: string, cards: Card[], piles: string[]) => Promise<void>;
}

export const deckGateway: DeckGateway = {
  create: newDeck,
  async move(deck, pile, cards) {
    if (cards.length) await request(`${deck}/pile/${pile}/add/?cards=${cards.map(card => card.code).join(',')}`);
  },
  async recycle(deck, cards, piles) {
    if (!cards.length) return;
    // The server holds the shuffled stock. Returning these exact codes before
    // drawing them makes retries safe even if a prior draw response was lost.
    const codes = cards.map(card => card.code).join(',');
    // The general return endpoint only returns unpiled cards. Empty each
    // player's actual piles first; repeats safely return zero extra cards.
    for (const pile of piles) await request(`${deck}/pile/${pile}/return/?cards=${codes}`);
    await request(`${deck}/return/?cards=${codes}`);
    const data = await request(`${deck}/draw/?count=${cards.length}`);
    const expected = new Set(cards.map(card => card.code));
    if (data.cards?.length !== cards.length || data.cards.some(card => !expected.has(card.code))) {
      throw new Error('The returned cards could not be verified. Retrying the return.');
    }
  },
};
