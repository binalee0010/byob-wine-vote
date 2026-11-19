import type { Candidate } from './api';

export default function CandidatePhoto({ candidate, onPhoto, compact = false, eager = false, draggable }: {
  candidate: Candidate;
  onPhoto: (candidate: Candidate) => void;
  compact?: boolean;
  eager?: boolean;
  draggable?: boolean;
}) {
  if (!candidate.photoUrl) return <span className={compact ? 'rank-photo wine-number' : 'wine-number'} aria-hidden={compact || undefined}>
    와인 {String(candidate.number).padStart(2, '0')}
  </span>;
  return <button className={compact ? 'rank-photo' : 'photo-button'} type="button" onClick={() => onPhoto(candidate)} aria-label={candidate.name + ' 사진 확대'}>
    <img src={candidate.photoUrl} alt={compact ? '' : candidate.name} loading={eager ? undefined : 'lazy'} draggable={draggable} />
    {!compact && <span>사진 확대 ↗</span>}
  </button>;
}
