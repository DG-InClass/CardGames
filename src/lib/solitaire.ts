import { assertDeck, isRed, rankValue, SUITS, type Card } from './cards';

export type TableauCard = Card & { faceUp: boolean };
export type SolitaireState = { stock: Card[]; waste: Card[]; tableau: TableauCard[][]; foundations: Card[][]; moves: number };
export type Source = { kind: 'waste' } | { kind: 'tableau'; column: number; index: number } | { kind: 'foundation'; column: number };
export type Destination = { kind: 'tableau' | 'foundation'; column: number };

export function dealSolitaire(cards: Card[]): SolitaireState {
  assertDeck(cards);
  let offset = 0;
  const tableau = Array.from({ length: 7 }, (_, column) => cards.slice(offset, offset += column + 1)
    .map((card, index) => ({ ...card, faceUp: index === column })));
  return { stock: cards.slice(28), waste: [], tableau, foundations: [[], [], [], []], moves: 0 };
}

export function drawStock(state: SolitaireState): SolitaireState {
  if (!state.stock.length && !state.waste.length) return state;
  const next = structuredClone(state);
  if (next.stock.length) next.waste.push(next.stock.shift()!);
  else { next.stock = next.waste; next.waste = []; }
  next.moves++;
  return next;
}

export function sourceCards(state: SolitaireState, source: Source): Card[] {
  if (source.kind === 'waste') return state.waste.slice(-1);
  if (source.kind === 'foundation') return state.foundations[source.column]?.slice(-1) ?? [];
  const pile = state.tableau[source.column];
  if (!pile?.[source.index]?.faceUp) return [];
  return pile.slice(source.index);
}

export function moveCards(state: SolitaireState, source: Source, target: Destination): SolitaireState | null {
  if (source.kind === target.kind && 'column' in source && source.column === target.column) return null;
  const cards = sourceCards(state, source);
  if (!cards.length) return null;
  if (target.kind === 'foundation') {
    const pile = state.foundations[target.column];
    if (!pile || cards.length !== 1 || cards[0].suit !== SUITS[target.column] || rankValue(cards[0]) !== pile.length + 1) return null;
  } else {
    const pile = state.tableau[target.column];
    if (!pile) return null;
    const top = pile.at(-1);
    if (top ? isRed(top) === isRed(cards[0]) || rankValue(top) !== rankValue(cards[0]) + 1 : rankValue(cards[0]) !== 13) return null;
  }
  const next = structuredClone(state);
  if (source.kind === 'waste') next.waste.pop();
  else if (source.kind === 'foundation') next.foundations[source.column].pop();
  else {
    next.tableau[source.column].splice(source.index);
    const exposed = next.tableau[source.column].at(-1);
    if (exposed) exposed.faceUp = true;
  }
  if (target.kind === 'foundation') next.foundations[target.column].push(...cards);
  else next.tableau[target.column].push(...cards.map(card => ({ ...card, faceUp: true })));
  next.moves++;
  return next;
}

export const hasWon = (state: SolitaireState) => state.foundations.every(pile => pile.length === 13);

export function findHint(state: SolitaireState): { source: Source; target: Destination } | null {
  const sources: Source[] = [{ kind: 'waste' }];
  state.tableau.forEach((pile, column) => pile.forEach((card, index) => {
    if (card.faceUp) sources.push({ kind: 'tableau', column, index });
  }));
  for (const kind of ['foundation', 'tableau'] as const) {
    for (const source of sources) {
      for (let column = 0; column < (kind === 'foundation' ? 4 : 7); column++) {
        // Moving an entire king-led column to an empty column doesn't help.
        if (kind === 'tableau' && !state.tableau[column].length && source.kind === 'tableau' && source.index === 0) continue;
        if (moveCards(state, source, { kind, column })) return { source, target: { kind, column } };
      }
    }
  }
  return null;
}
