import { useEffect, useRef, useState } from 'react';
import type { Activity, AdminSettingsPatch, AdminState, VotingMethod } from './api';
import { positiveInteger } from './format';

export function syncedDraft(draft: string, previous: string, next: string) { return draft === previous ? next : draft; }
export function useServerDraft(serverValue: string) {
  const [draft, setDraft] = useState(serverValue);
  const previous = useRef(serverValue);
  useEffect(() => {
    const before = previous.current;
    previous.current = serverValue;
    setDraft(current => syncedDraft(current, before, serverValue));
  }, [serverValue]);
  return [draft, setDraft] as const;
}
export function passwordChangeError(current: string, next: string, confirmation: string) {
  if (!current || current.length > 1024) return '현재 비밀번호를 입력해 주세요.';
  if (next.length < 10 || next.length > 1024) return '새 비밀번호는 10자 이상 1,024자 이하로 입력해 주세요.';
  if (next !== confirmation) return '새 비밀번호와 확인 입력이 일치하지 않습니다.';
  return '';
}

export function moveCandidateRank(ranking: string[], candidateId: string, index: number) {
  const previous = ranking.indexOf(candidateId);
  if (previous < 0 || index < 0 || index >= ranking.length || previous === index) return ranking;
  const next = [...ranking];
  next.splice(previous, 1);
  next.splice(index, 0, candidateId);
  return next;
}

export function isCompleteRanking(ranking: string[], candidates: { id: string }[], count = candidates.length) {
  return count > 0 && ranking.length === count && new Set(ranking).size === count
    && ranking.every(id => candidates.some(candidate => candidate.id === id));
}

export function selectCustomRank(ranking: string[], candidateId: string, place: number | null, count: number) {
  if (place !== null && (place < 0 || place >= count || !Number.isInteger(place))) return ranking;
  if (place !== null && ranking[place]) return ranking;
  const next = Array.from({ length: count }, (_, index) => ranking[index] === candidateId ? '' : ranking[index] ?? '');
  if (place !== null) next[place] = candidateId;
  return next;
}

export function candidateNameChanges(candidates: { id: string; name: string }[], fields: FormData) {
  return candidates.flatMap(candidate => {
    const input = fields.get(candidate.id);
    if (typeof input !== 'string') return [];
    const name = input.normalize('NFKC').trim();
    return name === candidate.name ? [] : [{ id: candidate.id, name }];
  });
}

type SettingsState = Pick<AdminState, 'event' | 'activities'>;
export const maxRankCount = 100;
export const maxRankPoint = 1_000_000;
export function customRankCount(value: string) { return positiveInteger(value) && Number(value) <= maxRankCount ? Number(value) : 0; }

export function progressFieldKey(activity: Pick<Activity, 'id' | 'revision'>, field: 'title' | 'resultVisibility' | 'votingMethod' | 'rankCount' | `rankPoint:${number}`) {
  return `${activity.id}:${activity.revision}:${field}`;
}

export function progressServerFields(state: SettingsState) {
  const fields: Record<string, string> = {
    'event:title': state.event.title,
    'event:participationMode': state.event.participationMode ?? 'open',
  };
  for (const activity of state.activities) {
    fields[progressFieldKey(activity, 'title')] = activity.title;
    fields[progressFieldKey(activity, 'resultVisibility')] = activity.resultVisibility;
    if (activity.started) continue;
    const rankPoints = activity.rankPoints ?? [3, 1];
    fields[progressFieldKey(activity, 'votingMethod')] = activity.votingMethod ?? 'full';
    fields[progressFieldKey(activity, 'rankCount')] = String(rankPoints.length);
    for (let place = 0; place < maxRankCount; place++) fields[progressFieldKey(activity, `rankPoint:${place}`)] = rankPoints[place]?.toString() ?? '';
  }
  return fields;
}

export function keepProgressEdits(edits: Record<string, string>, server: Record<string, string>) {
  const entries = Object.entries(edits);
  const dirty = entries.filter(([key, value]) => server[key] !== undefined && value !== server[key]);
  return dirty.length === entries.length ? edits : Object.fromEntries(dirty);
}

export function progressDraftChanges(state: SettingsState, server: Record<string, string>, edits: Record<string, string>) {
  const changes = keepProgressEdits(edits, server);
  const activity = state.activities.find(row => row.id === 'byob' && !row.started);
  if (!activity) return changes;
  const methodKey = progressFieldKey(activity, 'votingMethod');
  const countKey = progressFieldKey(activity, 'rankCount');
  const custom = (changes[methodKey] ?? server[methodKey]) === 'custom';
  const count = custom ? customRankCount(changes[countKey] ?? server[countKey]) : 0;
  const pointKeys = new Set(Array.from({ length: count }, (_, place) => progressFieldKey(activity, `rankPoint:${place}`)));
  return Object.fromEntries(Object.entries(changes).filter(([key]) => {
    if (key === countKey) return custom;
    return !key.includes(':rankPoint:') || pointKeys.has(key);
  }));
}

export function progressSettingsUpdate(state: SettingsState, server: Record<string, string>, edits: Record<string, string>) {
  const normalized = { ...progressDraftChanges(state, server, edits) };
  for (const [key, value] of Object.entries(normalized)) {
    if (key.endsWith(':title')) {
      normalized[key] = value.normalize('NFKC').trim();
      if (!normalized[key]) throw new Error('제목을 입력해 주세요.');

    }
  }
  const changes = keepProgressEdits(normalized, server);
  const patch: AdminSettingsPatch = {};
  const event: NonNullable<AdminSettingsPatch['event']> = {};
  if (changes['event:title'] !== undefined) event.title = changes['event:title'];
  const participationMode = changes['event:participationMode'];
  if (participationMode !== undefined) {
    if (participationMode !== 'open' && participationMode !== 'restricted') throw new Error('참가 방식을 확인해 주세요.');
    event.participationMode = participationMode;
  }
  if (Object.keys(event).length) patch.event = event;
  const activities = state.activities.flatMap<NonNullable<AdminSettingsPatch['activities']>[number]>(activity => {
    const title = changes[progressFieldKey(activity, 'title')];
    const resultVisibility = changes[progressFieldKey(activity, 'resultVisibility')];
    if (resultVisibility !== undefined && resultVisibility !== 'private' && resultVisibility !== 'public') throw new Error('결과 공개 설정을 확인해 주세요.');
    const methodKey = progressFieldKey(activity, 'votingMethod');
    const countKey = progressFieldKey(activity, 'rankCount');
    const votingMethod = changes[methodKey] as VotingMethod | undefined;
    let rankPoints: number[] | undefined;
    const customChanged = votingMethod === 'custom' || changes[countKey] !== undefined || Object.keys(changes).some(key => key.startsWith(`${activity.id}:${activity.revision}:rankPoint:`));
    if ((votingMethod ?? activity.votingMethod) === 'custom' && customChanged) {
      const count = customRankCount(changes[countKey] ?? server[countKey]);
      if (!count) throw new Error(`선택 개수는 1개부터 ${maxRankCount}개까지 입력해 주세요.`);
      changes[countKey] = String(count);
      rankPoints = Array.from({ length: count }, (_, place) => {
        const key = progressFieldKey(activity, `rankPoint:${place}`);
        const value = changes[key] ?? server[key];
        if (!/^\d+$/.test(value) || Number(value) > maxRankPoint) throw new Error(`${place + 1}위 배점을 0~1,000,000 사이의 정수로 입력해 주세요.`);
        changes[key] = String(Number(value));
        return Number(value);
      });
      if (!rankPoints.some(points => points > 0)) throw new Error('적어도 한 순위의 배점은 1점 이상이어야 합니다.');
    }
    if (title === undefined && votingMethod === undefined && rankPoints === undefined && resultVisibility === undefined) return [];
    return [{
      id: activity.id, revision: activity.revision, title,
      votingMethod, ...(rankPoints ? { rankPoints } : {}), ...(resultVisibility ? { resultVisibility } : {}),
    }];
  });
  if (activities.length) patch.activities = activities;
  return { patch, changes: keepProgressEdits(changes, server) };
}
