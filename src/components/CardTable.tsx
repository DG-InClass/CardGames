import { useEffect, useState } from 'react';
import Solitaire from './Solitaire';
import GoFish from './GoFish';
import PlayingCard from './PlayingCard';
import type { Card } from '../lib/cards';

type Page = 'home' | 'solitaire' | 'gofish';
const decorativeCard = (code: string, value: Card['value'], suit: Card['suit']): Card => ({ code, value, suit, image: '' });

export default function CardTable() {
  const [page, setPage] = useState<Page>('home');
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('game') === 'gofish' || query.has('room')) setPage('gofish');
  }, []);
  function navigate(next: Page) { setPage(next); window.scrollTo({ top: 0, behavior: 'smooth' }); }

  return <>
    <header className="site-header"><div className="header-inner"><button className="brand" onClick={() => navigate('home')} aria-label="Card Table home"><span className="brand-icon">♣</span><span>card table<span className="brand-period">.</span></span></button>
      <nav aria-label="Main navigation"><button aria-current={page === 'home' ? 'page' : undefined} onClick={() => navigate('home')}>The games</button><button aria-current={page === 'solitaire' ? 'page' : undefined} onClick={() => navigate('solitaire')}>Solitaire</button><button aria-current={page === 'gofish' ? 'page' : undefined} onClick={() => navigate('gofish')}>Go Fish</button></nav><span className="header-note"><i className="status-dot" /> A little time well played</span>
    </div></header>
    <main id="main-content" className="site-main">
      {page === 'home' && <>
        <section className="hero"><div className="hero-copy"><span className="eyebrow"><span className="tiny-diamond">◆</span> GOOD OLD GAMES. A FRESH DECK.</span><h1>Take a break.<br />Play a hand<span className="red-text">.</span></h1><p>For a quiet moment to yourself or a little friendly competition. The cards are shuffled. Your seat is ready.</p><button className="button dark-button" onClick={() => document.getElementById('choose-game')?.scrollIntoView({ behavior: 'smooth' })}>Find your game <span>↓</span></button><span className="hero-footnote">No sign-ups. No downloads. Just cards.</span></div>
          <div className="hero-art" aria-hidden="true"><span className="orbit-text">A GOOD HAND IS ALWAYS A GOOD IDEA</span><div className="hero-card hero-card-one"><PlayingCard card={decorativeCard('KC', 'KING', 'CLUBS')} /></div><div className="hero-card hero-card-two"><PlayingCard card={decorativeCard('QH', 'QUEEN', 'HEARTS')} /></div><div className="hero-card hero-card-three"><PlayingCard card={decorativeCard('AS', 'ACE', 'SPADES')} /></div><span className="art-spark spark-one">✦</span><span className="art-spark spark-two">✦</span><span className="handwritten">a little less scrolling,<br />a little more shuffling.</span></div>
        </section>
        <section className="choose-game" id="choose-game" aria-labelledby="choose-title"><div className="section-title"><div><span className="eyebrow">MAKE YOURSELF AT HOME</span><h2 id="choose-title">What are we playing?</h2></div><span className="section-note">Two classics. Plenty of good hands.</span></div>
          <div className="game-choices"><article className="game-choice"><div className="game-art solitaire-art" aria-hidden="true"><span className="art-label">THE SOLO CLASSIC</span><div className="mini-fan"><PlayingCard card={decorativeCard('AS', 'ACE', 'SPADES')} /><PlayingCard card={decorativeCard('2H', '2', 'HEARTS')} /><PlayingCard card={decorativeCard('3C', '3', 'CLUBS')} /></div><span className="corner-suit">♠</span></div><div className="game-choice-copy"><div className="section-title"><h3>Solitaire</h3><span className="pill">1 player</span></div><p>A familiar rhythm. A satisfying little challenge.<br />Make some order out of a shuffled deck.</p><button className="game-link" onClick={() => navigate('solitaire')}>Play Solitaire <span>↗</span></button></div></article>
          <article className="game-choice"><div className="game-art fish-art" aria-hidden="true"><span className="art-label">A LITTLE FRIENDLY COMPETITION</span><div className="fish-cards"><PlayingCard card={decorativeCard('7H', '7', 'HEARTS')} /><PlayingCard card={decorativeCard('7S', '7', 'SPADES')} /><PlayingCard card={decorativeCard('7D', '7', 'DIAMONDS')} /><PlayingCard card={decorativeCard('7C', '7', 'CLUBS')} /></div><span className="corner-suit">♥</span></div><div className="game-choice-copy"><div className="section-title"><h3>Go Fish</h3><span className="pill">2–4 players</span></div><p>Got any sevens? Bring a friend or join a table.<br />A little luck, a little memory, a lot of good company.</p><button className="game-link" onClick={() => navigate('gofish')}>Find a table <span>↗</span></button></div></article></div>
        </section>
        <div className="home-note"><span>♠ <i>♥</i> ♣ <i>♦</i></span><p>Nothing to keep up with. Just a game to get lost in.</p></div>
      </>}
      <div hidden={page !== 'solitaire'}><Solitaire active={page === 'solitaire'} /></div>
      <div hidden={page !== 'gofish'}><GoFish active={page === 'gofish'} /></div>
    </main>
    <footer className="site-footer"><span>card table. <span className="footer-subtle">A small space for a good game.</span></span><a href="https://www.deckofcardsapi.com/" target="_blank" rel="noreferrer">Dealt with Deck of Cards API ↗</a></footer>
  </>;
}
