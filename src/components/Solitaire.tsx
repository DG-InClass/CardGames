import { useEffect, useRef, useState } from 'react';
import { newDeck } from '../lib/deck-api';
import { SUITS, suitSymbol } from '../lib/cards';
import { dealSolitaire, drawStock, findHint, hasWon, moveCards, sourceCards, type Destination, type SolitaireState, type Source } from '../lib/solitaire';
import PlayingCard from './PlayingCard';

export default function Solitaire({ active }: { active: boolean }) {
  const [game, setGame] = useState<SolitaireState | null>(null);
  const [history, setHistory] = useState<SolitaireState[]>([]);
  const [selected, setSelected] = useState<Source | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('A little focus. A fresh deck.');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [confirmNew, setConfirmNew] = useState(false);
  const started = useRef(false);
  const won = game ? hasWon(game) : false;

  async function deal() {
    if (loading) return;
    setLoading(true); setError(''); setConfirmNew(false);
    try {
      const deck = await newDeck();
      setGame(dealSolitaire(deck.cards)); setHistory([]); setSelected(null); setSeconds(0);
      setMessage('Select a face-up card, then choose where it goes.');
    } catch { setError('Could not reach the card service. Check your connection and try dealing again.'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (active && !started.current) { started.current = true; void deal(); }
  }, [active]);
  useEffect(() => {
    if (!active || !game || won || loading) return;
    const timer = setInterval(() => setSeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active, Boolean(game), won, loading]);

  function apply(next: SolitaireState) {
    if (!game || loading) return;
    setHistory(previous => [...previous.slice(-99), game]);
    setGame(next); setSelected(null);
  }
  function destination(target: Destination) {
    if (!selected || !game || loading) return false;
    const next = moveCards(game, selected, target);
    if (!next) { setMessage('That move does not fit. Build down in alternating colors, or up by suit on an ace.'); return false; }
    apply(next); setMessage('Nicely played.'); return true;
  }
  function pick(source: Source) {
    if (loading || !game || !sourceCards(game, source).length) return;
    if (JSON.stringify(source) === JSON.stringify(selected)) { setSelected(null); return; }
    setSelected(source); setMessage('Card selected. Choose a column or a foundation.');
  }
  function hint() {
    if (!game) return;
    const suggestion = findHint(game);
    if (suggestion) {
      setSelected(suggestion.source);
      setMessage(`Try moving the selected card${sourceCards(game, suggestion.source).length > 1 ? 's' : ''} to ${suggestion.target.kind === 'tableau' ? `column ${suggestion.target.column + 1}` : `the ${suitSymbol(SUITS[suggestion.target.column])} foundation`}.`);
    } else setMessage(game.stock.length ? 'Draw a card from the stock.' : game.waste.length ? 'Recycle the waste to look through the stock again, or undo a move.' : 'No forward moves found. Undo a move or try a new deal.');
  }

  return <section className="game-page" aria-labelledby="solitaire-title">
    <div className="page-heading"><div><span className="eyebrow">A TABLE FOR ONE</span><h1 id="solitaire-title">Solitaire<span className="heading-suit">♠</span></h1><p>The classic. Just you and the cards.</p></div>
      <button className="button dark-button" disabled={loading} onClick={() => game && !won ? setConfirmNew(true) : void deal()}>{loading ? 'Shuffling…' : '↻ New deal'}</button>
    </div>
    {confirmNew && <div className="notice">Start a fresh game? Your current deal will be lost.<div className="button-row"><button className="button small-button" onClick={() => void deal()}>Deal again</button><button className="text-button" onClick={() => setConfirmNew(false)}>Keep playing</button></div></div>}
    {error && <div className="notice error-notice" role="alert">{error}<button className="text-button" onClick={() => void deal()} disabled={loading}>Try again</button></div>}
    <div className="table-toolbar"><span className="pill"><i className="status-dot" /> Klondike · Draw one</span><div className="game-stats"><span><b>{game?.moves ?? 0}</b> moves</span><span><b>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</b></span></div></div>
    <div className="solitaire-scroll">
      <div className={`felt solitaire-table ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
        {!game ? <div className="table-empty"><span className="large-suit">♠</span><h2>{loading ? 'Shuffling your deck…' : 'Your next hand is waiting.'}</h2><p>{loading ? 'Getting 52 fresh cards.' : 'Choose New deal to take a seat.'}</p></div> : <>
          <div className="solitaire-top">
            <div className="pile-group"><div><button className={`card-slot ${game.stock.length ? 'stock-card' : ''}`} aria-label={game.stock.length ? `Draw from stock, ${game.stock.length} cards remaining` : 'Recycle waste'} disabled={loading || won || (!game.stock.length && !game.waste.length)} onClick={() => { apply(drawStock(game)); setMessage(game.stock.length ? 'One card drawn.' : 'Waste recycled.'); }}>
              {game.stock.length ? <span className="back-pattern"><span>♣</span></span> : <span className="recycle-symbol">↻</span>}</button><span className="pile-label">STOCK · {game.stock.length}</span></div>
              <div>{game.waste.length ? <PlayingCard card={game.waste.at(-1)} selected={selected?.kind === 'waste'} onClick={() => pick({ kind: 'waste' })} disabled={loading || won} /> : <div className="card-slot" aria-label="Empty waste pile" />}<span className="pile-label">WASTE</span></div></div>
            <div className="foundation-group">{SUITS.map((suit, column) => <div key={suit}>
              <button className={`card-slot foundation-slot ${selected ? 'available-target' : ''}`} aria-label={`${suit.toLowerCase()} foundation, ${game.foundations[column].length} cards`} disabled={loading || won} onClick={() => selected ? destination({ kind: 'foundation', column }) : pick({ kind: 'foundation', column })}>
                {game.foundations[column].length ? <PlayingCard card={game.foundations[column].at(-1)} selected={selected?.kind === 'foundation' && selected.column === column} /> : <span className="foundation-suit">{suitSymbol(suit)}</span>}</button><span className="pile-label">{suit}</span>
            </div>)}</div>
          </div>
          <div className="tableau">{game.tableau.map((pile, column) => <div className="tableau-column" key={column} style={{ minHeight: `${145 + Math.max(0, pile.length - 1) * 30}px` }}>
            <button className={`card-slot empty-column ${selected ? 'available-target' : ''}`} onClick={() => destination({ kind: 'tableau', column })} disabled={loading || won || Boolean(pile.length)} aria-label={`Move to empty column ${column + 1}`}><span>K</span></button>
            {pile.map((card, index) => <div className="stacked-card" key={card.code} style={{ top: `${index * 30}px` }}><PlayingCard card={card} back={!card.faceUp} selected={selected?.kind === 'tableau' && selected.column === column && index >= selected.index} disabled={loading || won || !card.faceUp}
              label={card.faceUp ? `${card.value.toLowerCase()} of ${card.suit.toLowerCase()}, column ${column + 1}${index < pile.length - 1 ? ', with cards below' : ''}` : `Face-down card in column ${column + 1}`}
              onClick={() => { if (selected && !(selected.kind === 'tableau' && selected.column === column) && destination({ kind: 'tableau', column })) return; pick({ kind: 'tableau', column, index }); }} /></div>)}
          </div>)}</div>
        </>}
      </div>
    </div>
    <div className="game-bottom"><p role="status">{won ? 'All four suits, perfectly in order. You won!' : message}</p><div className="button-row"><button className="button outline-button small-button" disabled={!history.length || loading} onClick={() => { setGame(history.at(-1)!); setHistory(history.slice(0, -1)); setSelected(null); setMessage('Last move undone.'); }}>↶ Undo</button><button className="button outline-button small-button" onClick={hint} disabled={!game || loading || won}>✧ Hint</button></div></div>
    <details className="rules"><summary>A quick refresher</summary><p>Build columns down from king to ace, alternating red and black. Move a face-up card and all cards below it together. Only a king can fill an empty column. Build the four foundations up from ace to king in the same suit. Draw one card at a time; recycle the waste as often as you like. Select a card, then a destination. You can also move a foundation’s top card back to a column.</p></details>
  </section>;
}
