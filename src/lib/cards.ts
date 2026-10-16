export const SUITS = ['SPADES', 'HEARTS', 'CLUBS', 'DIAMONDS'] as const;
export const RANKS = ['ACE', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'JACK', 'QUEEN', 'KING'] as const;
export type Rank = typeof RANKS[number];
export type Suit = typeof SUITS[number];
export type Card = { code: string; value: Rank; suit: Suit; image: string };
export const suitSymbol = (suit: Suit) => ({ SPADES: '♠', HEARTS: '♥', CLUBS: '♣', DIAMONDS: '♦' })[suit];
export const rankLabel = (rank: Rank) => ({ ACE: 'A', JACK: 'J', QUEEN: 'Q', KING: 'K' })[rank as 'ACE'] || rank;
export const rankValue = (card: Card) => RANKS.indexOf(card.value) + 1;
export const isRed = (card: Card) => card.suit === 'HEARTS' || card.suit === 'DIAMONDS';
export const sortHand = (cards: Card[]) => [...cards].sort((a, b) => rankValue(a) - rankValue(b) || a.suit.localeCompare(b.suit));

export function assertDeck(cards: Card[]): void {
  if (cards.length !== 52 || new Set(cards.map(card => card.code)).size !== 52 || cards.some(card =>
    !RANKS.includes(card.value) || !SUITS.includes(card.suit) ||
    card.code !== `${card.value === '10' ? '0' : rankLabel(card.value)}${card.suit[0]}`)) {
    throw new Error('The card service returned an incomplete deck. Please try again.');
  }
}
