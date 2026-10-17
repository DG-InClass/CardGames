import { assertDeck, type Card } from './cards';

const BASE = 'https://www.deckofcardsapi.com/api/deck';
export const STOCK_PILE = 'stock';
export type Guard = () => Promise<void>;
export type PileSnapshot = { cards: Card[]; counts: Record<string, number>; remaining: number };
type DeckResponse = {
  success: boolean; error?: string; deck_id: string; cards?: Card[]; remaining: number;
  piles?: Record<string, { cards?: Card[]; remaining: number | string }>;
};

async function request(path: string, guard?: Guard): Promise<DeckResponse> {
  await guard?.();
  const response = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error('The card service is unavailable. Please try again.');
  const data = await response.json() as DeckResponse;
  if (!data.success) throw new Error('The card service could not complete this move. Please try again.');
  return data;
}

export async function newDeck(guard?: Guard) {
  const data = await request('new/draw/?count=52', guard);
  const cards = data.cards ?? [];
  assertDeck(cards);
  return { id: data.deck_id, cards };
}

export interface DeckGateway {
  create: typeof newDeck;
  pile: (deck: string, pile: string) => Promise<PileSnapshot>;
  move: (deck: string, pile: string, codes: string[], guard?: Guard) => Promise<void>;
  returnPile: (deck: string, pile: string, codes: string[], guard?: Guard) => Promise<void>;
  restoreStock: (deck: string, codes: string[], guard?: Guard) => Promise<void>;
  shuffleStock: (deck: string, guard?: Guard) => Promise<void>;
}

export const deckGateway: DeckGateway = {
  create: newDeck,
  async pile(deck, pile) {
    const data = await request(`${deck}/pile/${pile}/list/`);
    return {
      cards: data.piles?.[pile]?.cards ?? [], remaining: Number(data.remaining),
      counts: Object.fromEntries(Object.entries(data.piles ?? {}).map(([name, value]) => [name, Number(value.remaining)])),
    };
  },
  async move(deck, pile, codes, guard) {
    if (codes.length) await request(`${deck}/pile/${pile}/add/?cards=${codes.join(',')}`, guard);
  },
  async returnPile(deck, pile, codes, guard) {
    if (codes.length) await request(`${deck}/pile/${pile}/return/?cards=${codes.join(',')}`, guard);
  },
  async restoreStock(deck, codes, guard) {
    if (!codes.length) return;
    // An interrupted attempt may have left these cards in the stock pile,
    // unpiled, or in the main deck. Normalize all three before drawing again.
    await request(`${deck}/pile/${STOCK_PILE}/return/?cards=${codes.join(',')}`, guard);
    await request(`${deck}/return/?cards=${codes.join(',')}`, guard);
    const data = await request(`${deck}/draw/?count=${codes.length}`, guard);
    const expected = new Set(codes);
    if (data.cards?.length !== codes.length || new Set(data.cards.map(card => card.code)).size !== codes.length || data.cards.some(card => !expected.has(card.code))) {
      throw new Error('The returned cards could not be verified. The table remains paused.');
    }
    await request(`${deck}/pile/${STOCK_PILE}/add/?cards=${codes.join(',')}`, guard);
  },
  async shuffleStock(deck, guard) {
    await request(`${deck}/pile/${STOCK_PILE}/shuffle/`, guard);
  },
};
