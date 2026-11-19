import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import type { Candidate } from './api';
import CandidatePhoto from './CandidatePhoto';

type Props = {
  candidates: Candidate[];
  ranking: string[];
  submitted: boolean;
  disabled: boolean;
  onMove: (candidateId: string, index: number) => void;
  onPhoto: (candidate: Candidate) => void;
};
type Drag = {
  pointerId: number;
  candidate: Candidate;
  capture: HTMLElement;
  row: HTMLLIElement;
  ghost: HTMLDivElement | null;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  frame: number;
  lastFrame: number | null;
};

export function dragGhostTransform(x: number, y: number, offsetX: number, offsetY: number) {
  return `translate3d(${x - offsetX}px, ${y - offsetY}px, 0)`;
}

export function dragPreviewSlot(index: number, source: number, target: number) {
  if (source < 0 || target < 0) return index;
  if (index === source) return target;
  if (source < index && index <= target) return index - 1;
  if (target <= index && index < source) return index + 1;
  return index;
}

export function dragScrollDelta(bounds: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, x: number, y: number, viewportHeight: number, elapsed: number) {
  if (x < bounds.left || x > bounds.right) return 0;
  const step = Math.min(32, Math.max(0, elapsed)) * .3;
  // Leave the pointer inside the list after the browser rounds the scroll position.
  if (y < 54) return Math.max(-step, Math.min(0, bounds.top + 1 - y));
  if (y > viewportHeight - 54) return Math.min(step, Math.max(0, bounds.bottom - y - 1));
  return 0;
}

export default function RankedBallot({ candidates, ranking, submitted, disabled, onMove, onPhoto }: Props) {
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<Drag | null>(null);
  const focusAfterMove = useRef<HTMLButtonElement | null>(null);
  const suppressClick = useRef(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState(-1);
  const [announcement, setAnnouncement] = useState('');
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));

  useLayoutEffect(() => {
    const button = focusAfterMove.current;
    focusAfterMove.current = null;
    if (!button) return;
    const next = button.disabled ? button.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)') : button;
    next?.focus({ preventScroll: true });
  }, [ranking]);

  const releaseDrag = useCallback(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    cancelAnimationFrame(active.frame);
    active.ghost?.remove();
    if (active.capture.hasPointerCapture(active.pointerId)) active.capture.releasePointerCapture(active.pointerId);
    return active;
  }, []);
  const cancelDrag = useCallback(() => {
    const active = releaseDrag();
    if (active?.ghost) {
      suppressClick.current = true;
      setDraggedId(null);
      setDropIndex(-1);
    }
    return active;
  }, [releaseDrag]);
  useLayoutEffect(() => {
    window.addEventListener('blur', cancelDrag);
    return () => { window.removeEventListener('blur', cancelDrag); releaseDrag(); };
  }, [cancelDrag, releaseDrag]);
  useLayoutEffect(() => { if (disabled) cancelDrag(); }, [disabled, cancelDrag]);

  function move(candidate: Candidate, index: number) {
    onMove(candidate.id, index);
    setAnnouncement(`${candidate.name}, ${index + 1}위 ${ranking.length - index}점`);
  }

  function moveWithButton(event: MouseEvent<HTMLButtonElement>, candidate: Candidate, index: number) {
    if (drag.current) return;
    if (document.activeElement === event.currentTarget) focusAfterMove.current = event.currentTarget;
    move(candidate, index);
  }

  function indexAt(x: number, y: number) {
    const node = list.current;
    if (!node) return -1;
    const bounds = node.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return -1;
    // Layout offsets stay fixed while the rows animate into their preview slots.
    return Array.from(node.children).findIndex(child => {
      const row = child as HTMLLIElement;
      return y - bounds.top <= row.offsetTop + row.offsetHeight;
    });
  }

  function trackDrag(now: number) {
    const active = drag.current;
    const bounds = list.current?.getBoundingClientRect();
    if (!active || !bounds) return;
    active.frame = 0;
    const elapsed = active.lastFrame === null ? 16 : now - active.lastFrame;
    const delta = dragScrollDelta(bounds, active.x, active.y, window.innerHeight, elapsed);
    const before = window.scrollY;
    if (delta) window.scrollBy(0, delta);
    setDropIndex(indexAt(active.x, active.y));
    if (window.scrollY !== before) {
      active.lastFrame = now;
      active.frame = requestAnimationFrame(trackDrag);
    } else {
      active.lastFrame = null;
    }
  }

  function startDrag(event: PointerEvent<HTMLLIElement>, candidate: Candidate) {
    if (drag.current) return;
    suppressClick.current = false;
    if (disabled || ranking.length < 2 || event.button !== 0 || !event.isPrimary) return;
    const capture = event.target as HTMLElement;
    const onGrip = capture.closest('.rank-grip');
    if (capture.closest('.rank-actions') || (event.pointerType !== 'mouse' && !onGrip)) return;
    const row = event.currentTarget;
    const { left, top } = row.getBoundingClientRect();
    const { clientX: x, clientY: y, pointerId } = event;
    // Capturing the original target also preserves an ordinary click on a wine photo.
    capture.setPointerCapture(pointerId);
    const active: Drag = { pointerId, candidate, capture, row, ghost: null, offsetX: x - left, offsetY: y - top, startX: x, startY: y, x, y, frame: 0, lastFrame: null };
    drag.current = active;
    if (event.pointerType !== 'mouse') liftDrag(active);
  }

  function liftDrag(active: Drag) {
    const { width, height } = active.row.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'rank-row rank-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    // Copy the row once so the preview can follow the pointer without rendering the ballot on every move.
    for (const child of active.row.children) ghost.appendChild(child.cloneNode(true));
    ghost.style.width = width + 'px';
    ghost.style.height = height + 'px';
    ghost.style.transform = dragGhostTransform(active.x, active.y, active.offsetX, active.offsetY);
    document.body.appendChild(ghost);
    active.ghost = ghost;
    setDraggedId(active.candidate.id);
  }

  function updateDrag(event: PointerEvent<HTMLLIElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.x = event.clientX;
    active.y = event.clientY;
    if (!active.ghost) {
      if (Math.hypot(active.x - active.startX, active.y - active.startY) < 5) return;
      liftDrag(active);
    } else {
      active.ghost.style.transform = dragGhostTransform(active.x, active.y, active.offsetX, active.offsetY);
    }
    if (!active.frame) active.frame = requestAnimationFrame(trackDrag);
  }

  function endDrag(event: PointerEvent<HTMLLIElement>, commit = false) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    cancelDrag();
    if (!active.ghost || !commit || disabled) return;
    const target = indexAt(event.clientX, event.clientY);
    if (target !== -1 && target !== ranking.indexOf(active.candidate.id)) move(active.candidate, target);
  }

  const sourceIndex = draggedId ? ranking.indexOf(draggedId) : -1;
  return <fieldset className="ranked-ballot">
    <legend>와인 순위 정렬</legend>
    {!submitted && <p className="rank-draft">미제출 초안 · 처음에는 등록 순서로 표시됩니다.</p>}
    <p className="muted">{ranking.length > 1 ? '끌어서 옮기거나 ↑↓ 버튼을 눌러 가장 마음에 든 와인을 맨 위로 놓아 주세요. 터치 화면에서는 손잡이를 끌 수 있어요.' : '와인을 확인한 뒤 순위를 제출해 주세요.'}</p>
    <p className="rank-announcement" role="status">{announcement}</p>
    <ol className={draggedId ? 'rank-list rank-preview' : 'rank-list'} ref={list} role="list" onClickCapture={event => {
      if (suppressClick.current && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
      {ranking.map((id, index) => {
        const candidate = byId.get(id)!;
        const movable = !disabled && ranking.length > 1;
        const shift = dragPreviewSlot(index, sourceIndex, dropIndex) - index;
        const shiftStyle = shift ? { transform: `translateY(calc(${shift} * (var(--rank-row-height) + var(--rank-row-gap))))` } : undefined;
        return <li className={'rank-row' + (movable ? ' rank-movable' : '') + (index === sourceIndex ? ' rank-placeholder' : '')}
          style={shiftStyle} key={id} onPointerDown={e => startDrag(e, candidate)} onPointerMove={updateDrag}
          onPointerUp={e => endDrag(e, true)} onPointerCancel={e => endDrag(e)} onLostPointerCapture={e => endDrag(e)}>
          <div className={movable ? 'rank-grip can-drag' : 'rank-grip'}>
            {ranking.length > 1 && <span className="rank-grip-dots" aria-hidden="true">⠿</span>}
            <div><strong>{index + 1}위</strong><small>{ranking.length - index}점</small></div>
          </div>
          <CandidatePhoto candidate={candidate} onPhoto={onPhoto} compact draggable={false} />
          <div className="rank-wine"><small>와인 {candidate.number}</small><strong>{candidate.name}</strong></div>
          {ranking.length > 1 && <div className="rank-actions">
            <button type="button" aria-label={candidate.name + ' 위로 이동'} disabled={disabled || index === 0} onClick={e => moveWithButton(e, candidate, index - 1)}>↑</button>
            <button type="button" aria-label={candidate.name + ' 아래로 이동'} disabled={disabled || index === ranking.length - 1} onClick={e => moveWithButton(e, candidate, index + 1)}>↓</button>
          </div>}
        </li>;
      })}
    </ol>
  </fieldset>;
}
