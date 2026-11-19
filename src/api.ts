export type Id = 'byob';
export type VotingMethod = 'winner' | 'full' | 'custom';
export type ParticipationMode = 'open' | 'restricted';
export type Activity = { id: Id; title: string; status: 'waiting' | 'open' | 'closed'; published: boolean; started: boolean; revision: number; votingMethod?: VotingMethod; rankPoints?: number[] };
export type AdminActivity = Activity & { resultsLocked: boolean; resultVisibility: 'private' | 'public' };
export type EventInfo = { title: string; participationMode?: ParticipationMode };
export type AdminSettingsPatch = {
  event?: Partial<EventInfo>;
  activities?: (Pick<Activity, 'id' | 'revision'> & { title?: string; votingMethod?: VotingMethod; rankPoints?: number[]; resultVisibility?: 'private' | 'public' })[];
};
export type Participant = { id: string; name: string; submitted?: Record<Id, boolean> };
export type Bootstrap = { mode?: 'ranked-byob'; event: EventInfo; activities: Activity[]; participant: Participant | null; admin: boolean };
export type Candidate = { id: string; number: number; name: string; photoUrl: string | null };
export type VoteAnswer = { participantId: string; name: string } & { ranking: string[] };
export type ByobResult = Candidate & { candidateId: string; rank: number } & ({ votes: number } | { points: number });
export type AdminState = { mode?: 'ranked-byob'; participantUrl?: string; event: EventInfo; activities: AdminActivity[]; participants: Participant[]; rosterRevision: number; candidates: Candidate[]; photoCleanupPending: number; answers: { byob: VoteAnswer[] }; byobResults?: ByobResult[]; currentHistoryId?: string | null };
export type VoteHistorySummary = { id: string; title: string; activityTitle: string; startedAt: string; savedAt: string; votingMethod: VotingMethod; rankPoints: number[]; ballotCount: number };
export type VoteHistoryRecord = VoteHistorySummary & { rows: ByobResult[] };
export type Detail = { activity: Activity; mine: { ranking?: string[] } | null; candidates?: Candidate[]; selectionCount?: number };
export type Results = { title: string; id: 'byob'; revision?: number; votingMethod?: VotingMethod; rows: ByobResult[] };
export class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export const participantChangedMessage = '다른 화면에서 참가자 이름이 바뀌었습니다. 현재 이름을 확인한 뒤 다시 참여해 주세요.';
export function isParticipantChanged(error: unknown) { return error instanceof ApiError && error.code === 'participant_changed'; }
export function saveActivityAnswer(activity: Pick<Activity, 'id' | 'revision'>, expectedParticipantId: string, answer: { ranking: string[] }) {
  return api('/activities/' + activity.id + '/answer', 'PUT', { ...answer, revision: activity.revision, expectedParticipantId });
}
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('/api' + path, { method, cache: method === 'GET' ? 'no-store' : undefined, credentials: 'same-origin', signal: controller.signal, headers: data instanceof FormData ? undefined : data === undefined ? undefined : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data) });
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    if (!response.ok || body?.error) throw new ApiError(body?.error || '요청을 처리하지 못했습니다. 다시 시도해 주세요.', response.status, body?.code);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) throw new Error('Invalid API response');
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('연결을 확인한 뒤 다시 시도해 주세요. 작성한 내용은 유지됩니다.');
  } finally { window.clearTimeout(timer); }
}
export const statusText = { waiting: '대기 중', open: '진행 중', closed: '마감' };
