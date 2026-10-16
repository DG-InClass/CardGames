import { isRed, rankLabel, suitSymbol, type Card } from '../lib/cards';

type Props = { card?: Card; back?: boolean; selected?: boolean; label?: string; onClick?: () => void; disabled?: boolean; small?: boolean };

export default function PlayingCard({ card, back, selected, label, onClick, disabled, small }: Props) {
  const classes = `playing-card ${back ? 'card-back' : ''} ${card && isRed(card) ? 'red-card' : ''} ${selected ? 'selected-card' : ''} ${small ? 'small-card' : ''}`;
  const content = back ? <span className="back-pattern"><span>♣</span></span> : card ? <>
    <span className="card-corner"><b>{rankLabel(card.value)}</b><span>{suitSymbol(card.suit)}</span></span>
    <span className="card-suit">{suitSymbol(card.suit)}</span>
    <span className="card-corner bottom-corner"><b>{rankLabel(card.value)}</b><span>{suitSymbol(card.suit)}</span></span>
  </> : <span>{label}</span>;
  const name = label || (card ? `${card.value.toLowerCase()} of ${card.suit.toLowerCase()}` : 'Face-down card');
  return onClick ? <button type="button" className={classes} aria-label={name} aria-pressed={selected ?? false} disabled={disabled} onClick={onClick}>{content}</button>
    : <div className={classes} role="img" aria-label={name}>{content}</div>;
}
