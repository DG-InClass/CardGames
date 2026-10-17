import { useEffect, useRef, useState } from 'react';
import { RANKS, rankLabel, type Rank } from '../lib/cards';
import type { RoomSummary, RoomView } from '../lib/go-fish';
import PlayingCard from './PlayingCard';

type Session = { code: string; token: string };
const SESSION_KEY = 'card-table-fish';
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api<T>(session?: Session | null, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/gofish${!body && session ? `?room=${session.code}` : ''}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(60_000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
    ...(body ? { body: JSON.stringify({ ...body, ...(session ? { code: session.code } : {}) }) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? 'Could not reach the table.', response.status);
  return data as T;
}

export default function GoFish({ active }: { active: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [tables, setTables] = useState<RoomSummary[]>([]);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState('');
  const [rank, setRank] = useState<Rank | ''>('');
  const [opponent, setOpponent] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const currentSession = useRef<Session | null>(null);

  function saveSession(next: Session | null) {
    currentSession.current = next;
    setSession(next);
    try { if (next) sessionStorage.setItem(SESSION_KEY, JSON.stringify(next)); else sessionStorage.removeItem(SESSION_KEY); } catch { /* Playing still works without storage. */ }
  }
  function updateRoom(next: RoomView) {
    setRoom(previous => !previous || next.version >= previous.version ? next : previous);
  }
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (typeof saved.code === 'string' && typeof saved.token === 'string') saveSession(saved);
      }
      const sharedCode = new URLSearchParams(window.location.search).get('room');
      if (sharedCode && /^[a-f0-9]{6}$/i.test(sharedCode)) setCode(sharedCode.toUpperCase());
    } catch { /* Ignore expired or unavailable browser storage. */ }
  }, []);

  useEffect(() => {
    if (!session && !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (session) {
          const next = await api<RoomView>(session);
          if (!stopped) { updateRoom(next); setConnection(''); }
        } else {
          const list = await api<RoomSummary[]>();
          if (!stopped) { setTables(list); setConnection(''); }
        }
      } catch (error) {
        if (stopped) return;
        if (session && error instanceof ApiError && [401, 404].includes(error.status)) {
          saveSession(null); setRoom(null); setError(error.message);
        } else setConnection(error instanceof ApiError ? error.message : 'Reconnecting to the table… Keep this tab open.');
      } finally { if (!stopped) timer = setTimeout(poll, session ? 2000 : 5000); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, active]);

  useEffect(() => {
    if (rank && !room?.hand.some(card => card.value === rank)) setRank('');
    if (opponent && !room?.players.some(player => player.id === opponent && player.cardCount)) setOpponent('');
  }, [room, rank, opponent]);

  async function enter(type: 'create' | 'join', roomCode = code) {
    if (busy) return;
    if (!name.trim()) { setError('Add your name to pull up a chair.'); return; }
    setBusy(true); setError('');
    try {
      const result = await api<{ token: string; room: RoomView }>(null, { type, name: name.trim(), code: roomCode.toUpperCase() });
      saveSession({ code: result.room.code, token: result.token }); setRoom(result.room); setConnection('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not join the table.'); }
    finally { setBusy(false); }
  }

  async function action(type: 'start' | 'ask') {
    if (!session || !room || busy) return;
    setBusy(true); setError('');
    try {
      const next = await api<RoomView>(session, { type, version: room.version, opponent, rank });
      if (currentSession.current?.token === session.token) updateRoom(next);
      if (type === 'ask') setRank('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not complete the move.'); }
    finally { setBusy(false); }
  }

  async function leave() {
    if (!session || busy) return;
    setBusy(true); setError('');
    try {
      await api(session, { type: 'leave' });
      saveSession(null); setRoom(null); setRank(''); setOpponent(''); setConfirmLeave(false);
    } catch (error) {
      if (error instanceof ApiError && [401, 404].includes(error.status)) { saveSession(null); setRoom(null); setConfirmLeave(false); }
      else setError('Could not leave yet. Try again, or close this tab; your seat will expire after 45 seconds.');
    } finally { setBusy(false); }
  }

  const myTurn = room?.status === 'playing' && room.turn === room.you;
  const locked = busy || Boolean(room?.syncing) || Boolean(connection);
  const current = room?.players.find(player => player.id === room.turn);
  const myBooks = room?.players.find(player => player.id === room.you)?.books ?? [];

  return <section className="game-page" aria-labelledby="fish-title">
    <div className="page-heading"><div><span className="eyebrow">BETTER WITH COMPANY</span><h1 id="fish-title">Go Fish<span className="heading-suit red-text">♥</span></h1><p>A few friends. A friendly little rivalry.</p></div>{room && <button className="button outline-button" onClick={() => setConfirmLeave(true)}>Leave table ↗</button>}</div>
    {error && <div className="notice error-notice" role="alert">{error}<button className="text-button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {connection && <div className="notice" role="status">{connection}</div>}
    {confirmLeave && <div className="notice">Leave this table? Your hand and books will return to the pond.<div className="button-row"><button className="button small-button" disabled={busy} onClick={() => void leave()}>Leave table</button><button className="text-button" onClick={() => setConfirmLeave(false)}>Stay</button></div></div>}
    {session && !room ? <div className="panel"><h2>Finding your seat…</h2><p>Reconnecting to table {session.code}.</p><button className="button outline-button" onClick={() => void leave()} disabled={busy}>Leave table</button></div> : !room ? <div className="lobby-layout">
      <div className="panel join-panel"><span className="eyebrow">PULL UP A CHAIR</span><h2>Meet at the card table.</h2><p>No accounts. No fuss. Just 2–4 players and a deck of cards.</p>
        <label className="field-label" htmlFor="player-name">Your name</label><input id="player-name" placeholder="What should we call you?" autoComplete="nickname" maxLength={24} value={name} onChange={event => setName(event.target.value)} disabled={busy} />
        <button className="button dark-button full-width" onClick={() => void enter('create')} disabled={busy}>{busy ? 'Finding your seat…' : 'Create a table'}<span>＋</span></button>
        <div className="or-divider"><span>or join your friends</span></div>
        <form onSubmit={event => { event.preventDefault(); void enter('join'); }}><label className="field-label" htmlFor="room-code">Table code</label><div className="join-code"><input id="room-code" placeholder="A1B2C3" maxLength={6} value={code} onChange={event => setCode(event.target.value.toUpperCase().replace(/[^A-F0-9]/g, ''))} disabled={busy} /><button className="button dark-button" disabled={busy || code.length !== 6}>Join →</button></div></form>
        <p className="small-note">Tables are temporary. Keep this tab open while you play.</p>
      </div>
      <div className="open-tables"><div className="section-title"><h2>Open tables</h2><span className="pill">{tables.length} available</span></div><p>Join a game that hasn’t started yet.</p>
        {tables.length ? <ul className="table-list">{tables.map(table => <li key={table.code}><span className="table-icon">♣</span><div><b>{table.host}’s table</b><span>{table.code} · {table.playerCount}/4 seats</span></div><button className="button outline-button small-button" onClick={() => void enter('join', table.code)} disabled={busy}>Join →</button></li>)}</ul> : <div className="empty-lobby"><span>♧</span><h3>The table is yours.</h3><p>No open games just yet. Start one and invite someone along.</p></div>}
        <div className="lobby-note"><span>♡</span><p><b>A short game, a good time.</b><br />Collect the most books of four matching ranks. A player who leaves has all their cards shuffled back into the pond.</p></div>
      </div>
    </div> : <>
      <div className="table-toolbar"><div className="button-row"><span className="pill"><i className="status-dot" /> {room.status === 'waiting' ? 'Waiting for players' : room.status === 'playing' ? 'At the table' : 'Game over'}</span><span className="room-code">TABLE {room.code}</span></div><button className="text-button" onClick={async () => {
        try { await navigator.clipboard.writeText(`${window.location.origin}/?game=gofish&room=${room.code}`); setCopied(true); setTimeout(() => setCopied(false), 2500); }
        catch { setError(`Share this table code with your friends: ${room.code}`); }
      }}>{copied ? 'Link copied ✓' : 'Copy invite link ↗'}</button></div>
      {room.syncing && <div className="notice" role="status">{room.syncError ? 'The card service is taking a break. Your cards are safe; we’re retrying automatically.' : 'Shuffling and syncing the cards…'}</div>}
      <div className="fish-layout"><div>
        <div className="felt fish-table"><div className="player-seats">{room.players.map(player => <div key={player.id} className={`player-seat ${room.turn === player.id ? 'active-seat' : ''}`}><span className="avatar">{player.name.slice(0, 1).toUpperCase()}</span><strong>{player.name}{player.id === room.you ? ' (you)' : ''}</strong><span>{player.reconnecting ? 'Reconnecting…' : player.id === room.host ? 'Host' : 'At the table'}</span>{room.status !== 'waiting' && <small>{player.cardCount} cards · {player.books.length} books</small>}</div>)}
          {room.status === 'waiting' && Array.from({ length: 4 - room.players.length }, (_, i) => <div className="player-seat empty-seat" key={i}><span className="avatar">＋</span><strong>Open seat</strong><span>Invite a friend</span></div>)}
        </div>
        <div className="pond">{room.status === 'waiting' ? <><span className="large-suit">♣</span><h2>Good company makes a good game.</h2><p>Share the code <b>{room.code}</b> to fill the table.</p>{room.host === room.you ? <button className="button cream-button" disabled={locked || room.players.length < 2} onClick={() => void action('start')}>{busy ? 'Dealing…' : room.players.length < 2 ? 'Waiting for a friend…' : `Deal cards · ${room.players.length} players`}</button> : <span className="waiting-label">Waiting for the host to deal…</span>}</>
          : room.status === 'finished' || room.status === 'cancelled' ? <><span className="large-suit">{room.status === 'finished' ? '♛' : '♧'}</span><h2>{room.status === 'finished' ? `${room.winners.join(' & ')} ${room.winners.length > 1 ? 'tie!' : 'wins!'}` : 'Until the next hand.'}</h2><p>{room.status === 'finished' ? 'That was a good one. Another round?' : 'The game ended because fewer than two players remain.'}</p><button className="button cream-button" disabled={busy} onClick={() => void leave()}>Back to the lobby →</button></>
          : <><div className="pond-deck"><PlayingCard back /><span className="stock-badge">{room.stockCount}</span></div><span className="pile-label">CARDS IN THE POND</span><h2>{myTurn ? 'Your turn. Go get that book.' : `${current?.name ?? 'Your friend'}’s turn.`}</h2><p>{myTurn ? 'Choose a rank in your hand, then ask a player.' : 'A little patience. Your next hand is coming.'}</p></>}
        </div></div>
        {room.status === 'playing' && <div className="hand-panel"><div className="section-title"><h2>Your hand <span className="muted-count">{room.hand.length}</span></h2><span className="small-note">Only you can see these cards</span></div>
          <div className="hand-cards">{room.hand.map(card => <PlayingCard key={card.code} card={card} selected={rank === card.value} onClick={() => setRank(card.value)} disabled={!myTurn || locked} small />)}{!room.hand.length && <p>Your hand is empty. Waiting for the remaining books.</p>}</div>
          <form className="ask-form" onSubmit={event => { event.preventDefault(); void action('ask'); }}><label>Ask for<select aria-label="Rank to ask for" value={rank} onChange={event => setRank(event.target.value as Rank)} disabled={!myTurn || locked}><option value="">Choose a rank</option>{RANKS.filter(value => room.hand.some(card => card.value === value)).map(value => <option value={value} key={value}>{rankLabel(value)}</option>)}</select></label><label>From<select aria-label="Player to ask" value={opponent} onChange={event => setOpponent(event.target.value)} disabled={!myTurn || locked}><option value="">Choose a player</option>{room.players.filter(player => player.id !== room.you && player.cardCount > 0).map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label><button className="button dark-button" disabled={!myTurn || !rank || !opponent || locked}>{busy ? 'Asking…' : 'Any of these? →'}</button></form>
        </div>}
      </div><aside className="game-sidebar"><div className="panel"><span className="eyebrow">THE SCORECARD</span><h2>Books on the table</h2>{room.players.map(player => <div className="score-row" key={player.id}><div><b>{player.name}</b><span>{player.books.map(rankLabel).join(' · ') || 'No books yet'}</span></div><strong>{player.books.length}</strong></div>)}<p className="small-note">Four of a kind = one book.<br />{myBooks.length ? `You have ${myBooks.length}. Keep it going.` : 'The most books wins.'}</p></div><div className="activity-panel"><span className="eyebrow">TABLE TALK</span><ol className="activity-log" aria-live="polite" aria-relevant="additions">{room.log.map((entry, index) => <li key={`${room.log.length - index}-${entry}`}>{entry}</li>)}</ol></div></aside></div>
    </>}
    <details className="rules"><summary>How to play Go Fish</summary><p>Two players get seven cards each; three or four get five. On your turn, ask another player for a rank you already hold. If they have it, take all their cards of that rank and ask again. Otherwise, draw one card from the pond. Drawing the rank you asked for earns another turn. Four matching ranks automatically become a book. An empty hand draws up to five cards while the pond has cards. When all cards are in books, the most books wins; ties share the win. Disconnected players have 45 seconds to reconnect before their hand and books return to the pond. A game with fewer than two players ends.</p></details>
  </section>;
}
