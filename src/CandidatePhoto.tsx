import type { Candidate } from './api';

export default function CandidatePhoto({ candidate, onPhoto, compact = false, eager = false, draggable }: {
  candidate: Candidate;
  onPhoto: (candidate: Candidate) => void;
  compact?: boolean;
  eager?: boolean;
  draggable?: boolean;
}) {
  if (!candidate.photoUrl && candidate.description) return <button className={compact ? 'rank-photo wine-number' : 'wine-number'} type="button" onClick={() => onPhoto(candidate)} aria-label={candidate.name + ' 설명 보기'}>와인 {String(candidate.number).padStart(2, '0')}{!compact && <small>설명 보기</small>}</button>;
  if (!candidate.photoUrl) return <span className={compact ? 'rank-photo wine-number' : 'wine-number'} aria-hidden={compact || undefined}>
    와인 {String(candidate.number).padStart(2, '0')}
  </span>;
  return <button className={compact ? 'rank-photo' : 'photo-button'} type="button" onClick={() => onPhoto(candidate)} aria-label={candidate.name + (candidate.description ? ' 사진과 설명 보기' : ' 사진 확대')}>
    <img src={candidate.photoUrl} alt={compact ? '' : candidate.name} loading={eager ? undefined : 'lazy'} draggable={draggable} />
    {!compact && <span>{candidate.description ? '사진과 설명 보기 ↗' : '사진 확대 ↗'}</span>}
  </button>;
}
