import { PasswordVerifier } from './password-verifier';
export { PasswordVerifier };
export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
  PASSWORD_VERIFIER: DurableObjectNamespace;
  ADMIN_PASSWORD_HASH?: string;
  PUBLIC_ORIGIN?: string;
  ADMIN_SESSION_COOKIE?: string;
  PARTICIPANT_SESSION_COOKIE?: string;
}

type ActivityId = 'byob';
type VotingMethod = 'winner' | 'top2' | 'full';
type ParticipationMode = 'open' | 'restricted';
type Activity = { id: ActivityId; title: string; status: 'waiting' | 'open' | 'closed'; published: number; publish_on_close: number; started_at: string | null; revision: number; results_locked: number; voting_method?: VotingMethod; rank_points?: string };
type Participant = { id: string; name: string };
type Candidate = { id: string; number: number; name: string; object_key: string; content_type: string; request_id: string };
type RankedCandidate = Candidate & { score: number };
type HistoryCandidate = Omit<RankedCandidate, 'request_id'>;
type HistorySummary = { title: string; activityTitle: string; startedAt: string; votingMethod: VotingMethod; rankPoints: number[]; ballotCount: number };
type HistoryRow = { id: string; saved_at: string; snapshot: string };
type Session = { role: 'admin' | 'participant'; participant_id: string | null; token_hash: string };
type AnswerRow = { participant_id: string; name: string; payload: string };
const ids: ActivityId[] = ['byob'];
const encoder = new TextEncoder();
const MAX_PHOTO = 5 * 1024 * 1024;
const activeAdmin = "EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND role='admin' AND expires_at>?)";
const activeParticipant = "EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND role='participant' AND participant_id=? AND expires_at>?)";
const cookieNames = { admin: '__Host-byob_admin', participant: '__Host-byob_participant' };
const noOtherActivityData = "NOT EXISTS(SELECT 1 FROM answers WHERE activity_id<>'byob') AND NOT EXISTS(SELECT 1 FROM activities WHERE id<>'byob' AND (started_at IS NOT NULL OR status<>'waiting' OR published<>0))";
class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'invalid_request') { super(message); }
}
function fail(status: number, message: string, code?: string): never { throw new ApiError(status, message, code); }
function json(value: unknown, status = 200, headers?: HeadersInit) { return Response.json(value, { status, headers }); }
function ok() { return json({ ok: true }); }
function text(value: unknown, field: string, max = 120, required = true) {
  if (typeof value !== 'string') fail(400, `${field} 형식이 올바르지 않습니다.`);
  const result = value.normalize('NFKC').trim();
  if ((required && !result) || result.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(result)) fail(400, `${field} 내용을 확인해 주세요.`);
  return result;
}
function normalizeName(value: unknown) { return text(value, '이름', 80).replace(/\s+/gu, ' '); }
function nameKey(value: string) { return value.toLocaleLowerCase('ko-KR'); }
function activityId(value: string): ActivityId {
  if (value !== 'byob') fail(404, '투표가 없습니다.');
  return value;
}
function revisionNumber(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(400, '회차 정보를 확인해 주세요.');
  return value;
}
function requestRevision(value: unknown) { return revisionNumber(value === undefined ? 0 : value); }
function checkParticipantIdentity(expected: unknown, participantId: string | null) {
  if (!participantId) fail(401, '이름을 먼저 확인해 주세요.', 'unauthorized');
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !expected.trim() || expected.length > 80) fail(400, '참가자 정보를 확인해 주세요.');
  if (expected !== participantId) fail(409, '참가자 이름이 바뀌었습니다. 현재 이름을 확인한 뒤 다시 시도해 주세요.', 'participant_changed');
}
function sameRevision(activity: Activity, expected: number) {
  if (activity.revision !== expected) fail(409, '이벤트 회차가 바뀌었습니다. 화면을 새로 고쳐 주세요.', 'revision_changed');
}
function publicVotingMethod(method?: VotingMethod) { return method === 'top2' ? 'custom' : method ?? 'full'; }
function rankPoints(a: Activity): number[] { return JSON.parse(a.rank_points ?? '[3,1]'); }
function activityPublic(a: Activity) {
  return { id: a.id, title: a.title, status: a.status, published: Boolean(a.published),
    started: a.started_at !== null, revision: a.revision,
    votingMethod: publicVotingMethod(a.voting_method), rankPoints: rankPoints(a) };
}
function candidatePublic(c: Pick<Candidate, 'id' | 'number' | 'name' | 'object_key'>) { return { id: c.id, number: c.number, name: c.name, photoUrl: c.object_key ? `/api/photos/${c.id}` : null }; }
async function body(request: Request, max = 32768): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'JSON 요청이 필요합니다.');
  const raw = await boundedBody(request, max);
  try { const value = JSON.parse(new TextDecoder().decode(raw)); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* handled below */ }
  return fail(400, 'JSON 요청을 확인해 주세요.');
}
async function boundedBody(request: Request, max: number): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > max) fail(413, '요청 크기가 너무 큽니다.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > max) { await reader.cancel(); fail(413, '요청 크기가 너무 큽니다.'); } chunks.push(value); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
function sameOrigin(request: Request) { if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') fail(403, '같은 사이트에서 다시 요청해 주세요.', 'csrf'); }
async function digest(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), b => b.toString(16).padStart(2, '0')).join(''); }
function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
function readCookie(request: Request, name: string) { return request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''; }
function cookieName(env: Env, role: 'admin' | 'participant') {
  const name = (role === 'admin' ? env.ADMIN_SESSION_COOKIE : env.PARTICIPANT_SESSION_COOKIE) ?? cookieNames[role];
  if (!/^__Host-[A-Za-z0-9_-]{1,64}$/.test(name)) fail(503, '세션 설정을 확인해 주세요.', 'session_unconfigured');
  return name;
}
function sessionCookie(env: Env, role: 'admin' | 'participant', token: string, seconds: number) { return `${cookieName(env, role)}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`; }
async function session(request: Request, env: Env, role: 'admin' | 'participant'): Promise<Session | null> {
  const token = readCookie(request, cookieName(env, role)); if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const version=role==='admin'?await credentialVersion(env):null;
  return env.DB.prepare("SELECT role,participant_id,token_hash FROM sessions WHERE token_hash=? AND role=? AND expires_at>? AND(role='participant' OR credential_version=?)").bind(await digest(token), role, Date.now(),version).first<Session>();
}
async function requireAdmin(request: Request, env: Env) { return await session(request, env, 'admin') ?? fail(401, '관리자 로그인이 필요합니다.', 'unauthorized'); }
async function requireParticipant(request: Request, env: Env) {
  const s = await session(request, env, 'participant'); if (!s?.participant_id) fail(401, '이름을 먼저 확인해 주세요.', 'unauthorized');
  const participant = await env.DB.prepare('SELECT id,name FROM participants WHERE id=?').bind(s.participant_id).first<Participant>() ?? fail(401, '이름을 다시 확인해 주세요.', 'unauthorized');
  return { ...participant, token_hash: s.token_hash };
}
async function createSession(request: Request, env: Env, role: 'admin' | 'participant', participantId: string | null,version:string|null=null) {
  const token = randomToken(); const seconds = role === 'admin' ? 12 * 3600 : 30 * 24 * 3600;
  const old = readCookie(request, cookieName(env, role));
  const result=await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE token_hash=? OR expires_at<=?').bind(await digest(old), Date.now()),
    env.DB.prepare(`INSERT INTO sessions(token_hash,role,participant_id,expires_at,credential_version) SELECT ?,?,?,?,?
      WHERE (?='participant' AND EXISTS(SELECT 1 FROM participants WHERE id=?))
         OR (?='admin' AND EXISTS(SELECT 1 FROM admin_credentials WHERE id=1 AND version=?))`)
      .bind(await digest(token), role, participantId, Date.now() + seconds * 1000, version, role, participantId, role, version)
  ]);
  if (!result[1].meta.changes && role === 'participant') fail(404, '등록된 이름을 확인해 주세요.', 'participant_not_found');
  if(!result[1].meta.changes)fail(409,'비밀번호가 변경되었습니다. 다시 로그인해 주세요.','credential_changed');
  return sessionCookie(env, role, token, seconds);
}
async function revoke(request: Request, env: Env, role: 'admin' | 'participant', all = false) {
  if (all) await env.DB.prepare("DELETE FROM sessions WHERE role='admin'").run();
  else await env.DB.prepare('DELETE FROM sessions WHERE token_hash=? AND role=?').bind(await digest(readCookie(request, cookieName(env, role))), role).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(env, role, '', 0) });
}
async function rateLimit(request: Request, env: Env, scope: string, limit: number) {
  const now = Date.now(), windowStart = Math.floor(now / 900000) * 900000;
  const key = await digest(`${scope}:${request.headers.get('cf-connecting-ip') ?? 'local'}`);
  const row = await env.DB.prepare('INSERT INTO login_attempts(key,window_start,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start=excluded.window_start THEN attempts+1 ELSE 1 END,window_start=excluded.window_start RETURNING attempts').bind(key, windowStart).first<{ attempts: number }>();
  if (!row || row.attempts > limit) fail(429, '시도가 너무 많습니다. 15분 뒤 다시 시도해 주세요.', 'rate_limited');
}
async function passwordService(env:Env,path:string,data?:unknown) {
  const url = `https://password.internal${path}`;
  const init = data === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  const stub = env.PASSWORD_VERIFIER.get(env.PASSWORD_VERIFIER.idFromName('admin-password'));
  return stub.fetch(url, init);
}
async function credentialVersion(env:Env) {
  const response=await passwordService(env,'/state');
  if (!response.ok) fail(503, '관리자 비밀번호 설정을 확인해 주세요.', 'admin_unconfigured');
  return ((await response.json()) as {version:string}).version;
}
async function verifyPassword(password: string, env: Env) {
  const response=await passwordService(env,'/verify',{password});
  if(!response.ok)fail(503,'관리자 비밀번호 설정을 확인해 주세요.','admin_unconfigured');
  return await response.json() as {valid:boolean;version:string};
}
async function changePassword(request:Request,env:Env,admin:Session) {
  await rateLimit(request,env,'admin-password',8);
  const data=await body(request);
  if(typeof data.currentPassword!=='string' || !data.currentPassword.length || data.currentPassword.length>1024 || typeof data.newPassword!=='string' || data.newPassword.length<10 || data.newPassword.length>1024)fail(400,'현재 비밀번호와 10~1024자의 새 비밀번호를 입력해 주세요.');
  const response=await passwordService(env,'/change',{currentPassword:data.currentPassword,newPassword:data.newPassword,sessionHash:admin.token_hash});
  if(response.status===403)fail(403,'현재 비밀번호가 일치하지 않습니다.','invalid_current_password');
  if(response.status===409)fail(409,'비밀번호 또는 세션이 변경되었습니다. 다시 로그인해 주세요.','credential_changed');
  if(!response.ok)fail(503,'관리자 비밀번호 설정을 확인해 주세요.','admin_unconfigured');
  return json({ok:true},200,{'Set-Cookie':sessionCookie(env,'admin','',0)});
}
async function activity(env: Env, id: ActivityId) { return await env.DB.prepare('SELECT * FROM activities WHERE id=?').bind(id).first<Activity>() ?? fail(404, '이벤트가 없습니다.'); }
function activityRows(env: Env) {
  return env.DB.prepare("SELECT * FROM activities WHERE id='byob'");
}
async function candidates(env: Env) { return (await env.DB.prepare('SELECT * FROM candidates ORDER BY number,id').all<Candidate>()).results; }
async function eventInfo(env: Env) {
  const e = await env.DB.prepare('SELECT title,starts_at AS startsAt,timezone,participation_mode AS participationMode FROM event WHERE id=1').first(); return e;
}
function answerRows(env: Env, id: ActivityId) {
  return env.DB.prepare('SELECT a.participant_id,p.name,a.payload FROM answers a JOIN participants p ON p.id=a.participant_id WHERE a.activity_id=? ORDER BY p.name,p.id').bind(id);
}
function rankRows<T>(rows: T[], value: (row: T) => number, descending = false) {
  const sorted = [...rows].sort((a, b) => descending ? value(b) - value(a) : value(a) - value(b)); let last: number | undefined; let rank = 0;
  return sorted.map((row, i) => { const n = value(row); if (n !== last) rank = i + 1; last = n; return { ...row, rank }; });
}
const rankedCandidateSql = `SELECT c.*,coalesce(tally.score,0) AS score FROM candidates c LEFT JOIN (
    SELECT ballot.value AS candidate_id,sum(CASE activity.voting_method
      WHEN 'winner' THEN 1
      WHEN 'top2' THEN CAST(json_extract(activity.rank_points,'$[' || ballot.key || ']') AS INTEGER)
      ELSE candidate_count.n-CAST(ballot.key AS INTEGER) END) AS score
    FROM answers a CROSS JOIN json_each(a.payload,'$.ranking') ballot
    CROSS JOIN (SELECT count(*) AS n FROM candidates) candidate_count
    JOIN activities activity ON activity.id=a.activity_id
    WHERE a.activity_id='byob' GROUP BY ballot.value
  ) tally ON c.id=tally.candidate_id ORDER BY c.number,c.id`;
function rankedResults(rows: HistoryCandidate[], method: VotingMethod) {
  const ranked = rankRows(rows, row => row.score, true);
  return ranked.map(c => ({ ...candidatePublic(c), candidateId: c.id, rank: c.rank, ...(method === 'winner' ? { votes: c.score } : { points: c.score }) }));
}
async function historySummary(row: HistoryRow, summary: HistorySummary) {
  const { title, activityTitle, startedAt, votingMethod, rankPoints, ballotCount } = summary;
  return { id: row.id, version: await digest(row.snapshot), title, activityTitle, startedAt, savedAt: row.saved_at, votingMethod: publicVotingMethod(votingMethod), rankPoints, ballotCount };
}
async function historyList(env: Env) {
  const records = await env.DB.prepare('SELECT id,saved_at,snapshot FROM vote_history ORDER BY revision DESC').all<HistoryRow>();
  return json({ records: await Promise.all(records.results.map(row => historySummary(row, JSON.parse(row.snapshot)))) });
}
async function historyRow(env: Env, id: string) {
  return await env.DB.prepare('SELECT id,saved_at,snapshot FROM vote_history WHERE id=?').bind(id).first<HistoryRow>()
    ?? fail(404, '저장한 투표 기록이 없습니다.');
}
async function historyDetail(env: Env, id: string) {
  const row = await historyRow(env, id);
  const snapshot = JSON.parse(row.snapshot) as HistorySummary & { rows: HistoryCandidate[] };
  return json({ record: {
    ...await historySummary(row, snapshot),
    rows: rankedResults(snapshot.rows, snapshot.votingMethod).map(candidate => ({
      ...candidate, photoUrl: candidate.photoUrl ? `/api/admin/history/${row.id}/photos/${candidate.id}` : null
    }))
  } });
}
async function changeHistory(request: Request, env: Env, admin: Session, id: string) {
  const data = await body(request, 1024 * 1024);
  if (typeof data.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(data.expectedVersion)) fail(400, '투표 기록 버전을 확인해 주세요.');
  const row = await historyRow(env, id);
  if (await digest(row.snapshot) !== data.expectedVersion) fail(409, '투표 기록이 바뀌었습니다. 다시 열어 확인해 주세요.', 'history_changed');
  let changed: D1Result;
  if (request.method === 'DELETE') {
    if (data.confirm !== 'delete-history') fail(400, '투표 기록 삭제를 확인해 주세요.');
    // Archive deletion intentionally leaves photo objects and all current voting data intact.
    changed = await env.DB.prepare(`DELETE FROM vote_history WHERE id=? AND snapshot=? AND ${activeAdmin}`)
      .bind(id, row.snapshot, admin.token_hash, Date.now()).run();
  } else {
    const title = text(data.title, '모임 이름', 160);
    const snapshot = JSON.parse(row.snapshot) as HistorySummary & { rows: HistoryCandidate[] };
    if (!Array.isArray(data.names) || data.names.length > snapshot.rows.length) fail(400, '와인 이름을 확인해 주세요.');
    const names = new Map<string, string>();
    for (const entry of data.names) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || names.has(entry.id)
        || !snapshot.rows.some(candidate => candidate.id === entry.id)) fail(400, '기록에 있는 와인을 확인해 주세요.');
      names.set(entry.id, text(entry.name, '와인 이름', 160));
    }
    snapshot.title = title;
    snapshot.rows = snapshot.rows.map(candidate => names.has(candidate.id) ? { ...candidate, name: names.get(candidate.id)! } : candidate);
    changed = await env.DB.prepare(`UPDATE vote_history SET snapshot=? WHERE id=? AND snapshot=? AND ${activeAdmin}`)
      .bind(JSON.stringify(snapshot), id, row.snapshot, admin.token_hash, Date.now()).run();
  }
  if (!changed.meta.changes) {
    await requireAdmin(request, env);
    await historyRow(env, id);
    fail(409, '투표 기록이 바뀌었습니다. 다시 열어 확인해 주세요.', 'history_changed');
  }
  return request.method === 'DELETE' ? ok() : historyDetail(env, id);
}
async function historyPhoto(env: Env, id: string, candidateId: string) {
  const candidate = await env.DB.prepare(`SELECT json_extract(c.value,'$.object_key') AS object_key,
    json_extract(c.value,'$.content_type') AS content_type FROM vote_history h CROSS JOIN json_each(h.snapshot,'$.rows') c
    WHERE h.id=? AND json_extract(c.value,'$.id')=?`).bind(id, candidateId).first<Pick<Candidate, 'object_key' | 'content_type'>>();
  if (!candidate?.object_key) fail(404, '사진이 없습니다.');
  const object = await env.PHOTOS.get(candidate.object_key);
  if (!object) fail(404, '사진이 없습니다.');
  return new Response(object.body, { headers: { 'Content-Type': candidate.content_type, 'Content-Disposition': 'inline' } });
}
async function saveHistory(request: Request, env: Env, admin: Session) {
  const data = await body(request);
  const revision = revisionNumber(data.expectedRevision), rosterRevision = revisionNumber(data.expectedRosterRevision);
  const id = crypto.randomUUID();
  const saved = await env.DB.prepare(`INSERT INTO vote_history(id,revision,saved_at,snapshot)
    SELECT ?,a.revision,?,json_object(
      'title',e.title,'activityTitle',a.title,'startedAt',a.started_at,'votingMethod',a.voting_method,
      'rankPoints',json(a.rank_points),'ballotCount',(SELECT count(*) FROM answers WHERE activity_id='byob'),
      'rows',(SELECT json_group_array(json_object('id',c.id,'number',c.number,'name',c.name,
        'object_key',c.object_key,'content_type',c.content_type,'score',c.score)) FROM (${rankedCandidateSql}) c)
    )
    FROM activities a CROSS JOIN event e WHERE a.id='byob' AND e.id=1 AND a.status='closed'
      AND a.revision=? AND e.roster_revision=? AND ${activeAdmin}
    ON CONFLICT(revision) DO NOTHING RETURNING id`)
    .bind(id, new Date().toISOString(), revision, rosterRevision, admin.token_hash, Date.now()).first<{ id: string }>();
  if (saved) return json({ ok: true, id: saved.id, reused: false });
  await requireAdmin(request, env);
  const current = await env.DB.prepare(`SELECT a.revision,a.status,e.roster_revision,h.id
    FROM activities a CROSS JOIN event e LEFT JOIN vote_history h ON h.revision=a.revision
    WHERE a.id='byob' AND e.id=1`).first<{ revision: number; status: string; roster_revision: number; id: string | null }>();
  if (current?.revision !== revision) fail(409, '이벤트 회차가 바뀌었습니다. 화면을 새로 고쳐 주세요.', 'revision_changed');
  if (current.roster_revision !== rosterRevision) fail(409, '참가자 명단이 바뀌었습니다. 다시 확인해 주세요.', 'roster_changed');
  if (current.status === 'closed' && current.id) return json({ ok: true, id: current.id, reused: true });
  return fail(409, '마감한 뒤 투표 기록을 저장할 수 있습니다.', 'history_not_closed');
}
async function bootstrap(request: Request, env: Env) {
  const [all, event, participantSession] = await Promise.all([
    activityRows(env).all<Activity>(), eventInfo(env), session(request, env, 'participant')
  ]);
  let participant: (Participant & { submitted: { byob: boolean } }) | null = null;
  if (participantSession?.participant_id) {
    const person = await env.DB.prepare('SELECT id,name FROM participants WHERE id=?')
      .bind(participantSession.participant_id).first<Participant>();
    if (person) {
      const submitted = await env.DB.prepare("SELECT 1 FROM answers WHERE activity_id='byob' AND participant_id=?")
        .bind(person.id).first();
      participant = { ...person, submitted: { byob: Boolean(submitted) } };
    }
  }
  return json({ event, activities: all.results.map(activityPublic), participant, admin: false, mode: 'ranked-byob' });
}
async function detail(request: Request, env: Env, id: ActivityId) {
  const participant = await requireParticipant(request, env);
  const initial = await activity(env, id);
  if (initial.status !== 'open' || initial.published) fail(403, '현재 참여할 수 없는 투표입니다.', 'activity_unavailable');
  const row = await env.DB.prepare("SELECT payload FROM answers WHERE activity_id=? AND participant_id=? AND EXISTS(SELECT 1 FROM activities WHERE id=? AND status='open' AND published=0)")
    .bind(id, participant.id, id).first<{ payload: string }>();
  const candidateRows = (await candidates(env)).map(candidatePublic);
  const current = await activity(env, id);
  sameRevision(current, initial.revision);
  if (current.status !== 'open' || current.published) fail(403, '현재 참여할 수 없는 투표입니다.', 'activity_unavailable');
  return json({ activity: activityPublic(current), mine: row ? JSON.parse(row.payload) : null, candidates: candidateRows,
    selectionCount: current.voting_method === 'winner' ? 1 : current.voting_method === 'top2' ? rankPoints(current).length : candidateRows.length });
}
async function submit(request: Request, env: Env, id: ActivityId) {
  const participant = await requireParticipant(request, env), data = await body(request);
  checkParticipantIdentity(data.expectedParticipantId, participant.id);
  const revision = requestRevision(data.revision), ranking = data.ranking;
  if (Object.keys(data).some(key => key !== 'ranking' && key !== 'revision' && key !== 'expectedParticipantId')
    || !Array.isArray(ranking) || !ranking.length
    || ranking.some(candidateId => typeof candidateId !== 'string' || !candidateId.length || candidateId.length > 80)
    || new Set(ranking).size !== ranking.length) {
    fail(400, '투표 방식에 맞는 후보를 한 번씩 선택해 주세요.', 'invalid_ranking');
  }
  let result: D1Result;
  try {
    result = await env.DB.prepare(`INSERT INTO answers(activity_id,participant_id,payload,updated_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM activities WHERE id=? AND revision=? AND status='open' AND published=0)
        AND EXISTS(SELECT 1 FROM participants WHERE id=?) AND ${activeParticipant}
      ON CONFLICT(activity_id,participant_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
      .bind(id, participant.id, JSON.stringify({ ranking }), new Date().toISOString(), id, revision, participant.id,
        participant.token_hash, participant.id, Date.now()).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('candidate_missing')) {
      fail(400, '투표 방식에 맞는 후보를 한 번씩 선택해 주세요.', 'invalid_ranking');
    }
    throw error;
  }
  if (!result.meta.changes) {
    sameRevision(await activity(env, id), revision);
    checkParticipantIdentity(participant.id, (await requireParticipant(request, env)).id);
    fail(409, '참여 상태나 후보가 변경되었습니다. 다시 확인해 주세요.', 'activity_closed');
  }
  return ok();
}
async function results(env: Env, id: ActivityId) {
  const initial = await activity(env, id);
  if (!initial.published) fail(403, '결과가 아직 공개되지 않았습니다.', 'results_unpublished');
  const rows = (await env.DB.prepare(rankedCandidateSql).all<RankedCandidate>()).results;
  const current = await activity(env, id);
  if (current.revision !== initial.revision || !current.published) fail(403, '결과가 아직 공개되지 않았습니다.', 'results_unpublished');
  return json({ id, title: initial.title, mode: 'ranked-byob', votingMethod: publicVotingMethod(initial.voting_method),
    revision: initial.revision, rows: rankedResults(rows, initial.voting_method ?? 'full') });
}
function participantUrl(request: Request, env: Env) {
  const configured = env.PUBLIC_ORIGIN;
  if (!configured) return new URL('/', request.url).href;
  try {
    const url = new URL(configured);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid origin');
    return new URL('/', url.origin).href;
  } catch { return fail(503, '참가 주소 설정을 확인해 주세요.', 'origin_unconfigured'); }
}
async function adminState(request: Request, env: Env) {
  const [event, activities, participants, candidateRows, cleanup, answers] = await env.DB.batch([
    env.DB.prepare('SELECT title,starts_at AS startsAt,timezone,participation_mode AS participationMode,roster_revision AS rosterRevision FROM event WHERE id=1'),
    env.DB.prepare("SELECT a.*,h.id AS current_history_id FROM activities a LEFT JOIN vote_history h ON h.revision=a.revision WHERE a.id='byob'"),
    env.DB.prepare('SELECT id,name FROM participants ORDER BY name,id'),
    env.DB.prepare(rankedCandidateSql), candidatePhotoCleanupCount(env), answerRows(env, 'byob')
  ]);
  const { rosterRevision, ...metadata } = event.results[0] as { title: string; startsAt: string; timezone: string; participationMode: ParticipationMode; rosterRevision: number };
  const activityList = activities.results as (Activity & { current_history_id: string | null })[];
  return json({
    mode: 'ranked-byob', event: metadata, rosterRevision, participantUrl: participantUrl(request, env),
    photoCleanupPending: (cleanup.results[0] as { count: number }).count,
    activities: activityList.map(a => ({ ...activityPublic(a), resultVisibility: a.publish_on_close ? 'public' : 'private', resultsLocked: Boolean(a.results_locked) })),
    participants: participants.results, candidates: (candidateRows.results as Candidate[]).map(candidatePublic),
    answers: { byob: (answers.results as AnswerRow[]).map(row => ({ participantId: row.participant_id, name: row.name, ranking: JSON.parse(row.payload).ranking })) },
    currentHistoryId: activityList[0]?.current_history_id ?? null,
    byobResults: rankedResults(candidateRows.results as RankedCandidate[], activityList[0]?.voting_method ?? 'full')
  });
}
function eventStartTime(value: unknown) {
  const startsAt = text(value, '행사 일시', 50);
  const parts=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?(?:Z|[+-]\d\d:\d\d)$/.exec(startsAt);
  if(!parts || !Number.isFinite(Date.parse(startsAt)))fail(400,'한국 시간의 유효한 행사 일시를 입력해 주세요.');
  const [year,month,day,hour,minute,second]=parts.slice(1).map(Number),leap=year%4===0 && (year%100!==0 || year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(month<1 || month>12 || day<1 || day>days[month-1] || hour>23 || minute>59 || second>59)fail(400,'한국 시간의 유효한 행사 일시를 입력해 주세요.');
  return startsAt;
}
async function updateEvent(request: Request, env: Env, admin: Session) {
  const data = await body(request);
  if (data.timezone !== 'Asia/Seoul') fail(400, '한국 시간의 유효한 행사 일시를 입력해 주세요.');
  const title = text(data.title, '행사명', 160), startsAt = eventStartTime(data.startsAt);
  const updated = await env.DB.prepare(`UPDATE event SET title=?,starts_at=?,timezone='Asia/Seoul' WHERE id=1 AND ${activeAdmin}`)
    .bind(title, startsAt, admin.token_hash, Date.now()).run();
  if (!updated.meta.changes) await requireAdmin(request, env);
  return ok();
}
function activitySettings(data: Record<string, unknown>) {
  const method = data.votingMethod;
  if (method !== undefined && method !== 'winner' && method !== 'top2' && method !== 'full' && method !== 'custom') {
    fail(400, '투표 방식을 확인해 주세요.', 'invalid_voting_method');
  }
  let points: string | null = method === 'top2' ? '[3,1]' : null;
  if (data.rankPoints !== undefined) {
    const values = data.rankPoints;
    if ((method !== undefined && method !== 'custom') || !Array.isArray(values) || values.length < 1 || values.length > 100
      || values.some(value => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) || !values.some(value => value > 0)) {
      fail(400, '등수별 배점을 0~1,000,000 사이의 정수로 입력해 주세요. 적어도 한 등수의 배점은 1점 이상이어야 합니다.', 'invalid_rank_points');
    }
    points = JSON.stringify(values);
  }
  const title = data.title === undefined ? null : text(data.title, '투표명', 100);
  return { title, votingMethod: method === 'custom' ? 'top2' : method ?? null, rankPoints: points };
}
async function configure(request: Request, env: Env, id: ActivityId, admin: Session) {
  const data = await body(request);
  const revision = requestRevision(data.revision);
  const { title, votingMethod, rankPoints: points } = activitySettings(data);
  const methodChanges = [votingMethod, points].filter(value => value !== null);
  const pointsOnly = points !== null && votingMethod === null;
  const lockedAfterStart = methodChanges.length > 0;
  const updated = await env.DB.prepare(`UPDATE activities
    SET title=coalesce(?,title)${votingMethod !== null ? ',voting_method=?' : ''}${points !== null ? ',rank_points=?' : ''}
    WHERE id=? AND revision=? AND (started_at IS NULL OR ?=0)${pointsOnly ? " AND voting_method='top2'" : ''}
    AND ${activeAdmin}`)
    .bind(title, ...methodChanges, id, revision, Number(lockedAfterStart), admin.token_hash, Date.now()).run();
  if (!updated.meta.changes) {
    await requireAdmin(request, env);
    const current = await activity(env, id);
    sameRevision(current, revision);
    if (pointsOnly && current.voting_method !== 'top2') fail(409, '투표 방식이 바뀌었습니다. 화면을 새로 고쳐 주세요.', 'voting_method_changed');
  }
  if (!updated.meta.changes && methodChanges.length) fail(409, '투표 방식과 배점은 리셋한 뒤 변경할 수 있습니다.', 'voting_method_locked');
  return ok();
}
async function updateSettings(request: Request, env: Env, admin: Session) {
  const data = await body(request);
  let title: string | null = null, startsAt: string | null = null;
  let participationMode: ParticipationMode | null = null;
  if (data.event !== undefined) {
    if (!data.event || typeof data.event !== 'object' || Array.isArray(data.event)) fail(400, '행사 설정을 확인해 주세요.');
    const event = data.event as Record<string, unknown>;
    if (event.timezone !== undefined && event.timezone !== 'Asia/Seoul') fail(400, '한국 시간의 유효한 행사 일시를 입력해 주세요.');
    if (event.title !== undefined) title = text(event.title, '행사명', 160);
    if (event.startsAt !== undefined) startsAt = eventStartTime(event.startsAt);
    if (event.participationMode !== undefined) {
      if (event.participationMode !== 'open' && event.participationMode !== 'restricted') fail(400, '참가 방식을 확인해 주세요.', 'invalid_participation_mode');
      participationMode = event.participationMode;
    }
  }
  const entries = data.activities === undefined ? [] : data.activities;
  if (!Array.isArray(entries) || entries.length > 1) fail(400, '투표 설정을 확인해 주세요.');
  const edits = entries.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '이벤트 설정을 확인해 주세요.');
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== 'string') fail(400, '이벤트를 확인해 주세요.');
    const id = activityId(entry.id);
    const settings = activitySettings(entry);
    const visibility = entry.resultVisibility;
    if (visibility !== undefined && visibility !== 'private' && visibility !== 'public') {
      fail(400, '결과 공개 범위를 확인해 주세요.', 'invalid_result_visibility');
    }
    const publishOnClose = visibility === undefined ? null : Number(visibility === 'public');
    if (publishOnClose === null && Object.values(settings).every(value => value === null)) fail(400, '저장할 이벤트 설정을 확인해 주세요.');
    return { id, revision: revisionNumber(entry.revision), publishOnClose, ...settings };
  });
  if (new Set(edits.map(edit => edit.id)).size !== edits.length) fail(400, '같은 이벤트가 두 번 포함되어 있습니다.');
  const saveEvent = title !== null || startsAt !== null || participationMode !== null;
  if (!saveEvent && !edits.length) fail(400, '저장할 설정을 확인해 주세요.');
  const encoded = JSON.stringify(edits);
  const pending = `WITH edits AS MATERIALIZED (
    SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.revision') AS revision,
      json_extract(value,'$.title') AS title,json_extract(value,'$.votingMethod') AS voting_method,
      json_extract(value,'$.rankPoints') AS rank_points,json_extract(value,'$.publishOnClose') AS publish_on_close FROM json_each(?)
  )`;
  // Each statement uses the same guard. Accepted updates cannot change any of its conditions.
  const guard = `${activeAdmin} AND EXISTS(SELECT 1 FROM event WHERE id=1) AND NOT EXISTS (
    SELECT 1 FROM edits e LEFT JOIN activities a ON a.id=e.id
    WHERE a.id IS NULL OR a.revision<>e.revision
    OR (e.rank_points IS NOT NULL AND coalesce(e.voting_method,a.voting_method)<>'top2')
    OR (a.started_at IS NOT NULL AND (
      (e.voting_method IS NOT NULL AND e.voting_method IS NOT a.voting_method)
      OR (e.rank_points IS NOT NULL AND e.rank_points IS NOT a.rank_points)
    ))
  )`;
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (saveEvent) statements.push(env.DB.prepare(`${pending}
    UPDATE event SET title=coalesce(?,title),starts_at=coalesce(?,starts_at),participation_mode=coalesce(?,participation_mode)
    WHERE id=1 AND ${guard} RETURNING id`)
    .bind(encoded, title, startsAt, participationMode, admin.token_hash, now));
  if (edits.length) statements.push(env.DB.prepare(`${pending}
    UPDATE activities SET title=coalesce((SELECT e.title FROM edits e WHERE e.id=activities.id),title),
      publish_on_close=coalesce((SELECT e.publish_on_close FROM edits e WHERE e.id=activities.id),publish_on_close),
      published=CASE WHEN status='closed'
        THEN coalesce((SELECT e.publish_on_close FROM edits e WHERE e.id=activities.id),published) ELSE published END,
      voting_method=coalesce((SELECT e.voting_method FROM edits e WHERE e.id=activities.id),voting_method),
      rank_points=coalesce((SELECT e.rank_points FROM edits e WHERE e.id=activities.id),rank_points)
    WHERE id IN (SELECT id FROM edits) AND ${guard} RETURNING id`)
    .bind(encoded, admin.token_hash, now));
  const saved = await env.DB.batch(statements);
  if (saved.reduce((count, result) => count + result.results.length, 0) === Number(saveEvent) + edits.length) return ok();
  await requireAdmin(request, env);
  const current = (await activityRows(env).all<Activity>()).results;
  for (const edit of edits) {
    const a = current.find(row => row.id === edit.id);
    if (a) sameRevision(a, edit.revision);
    if (edit.rankPoints !== null && (edit.votingMethod ?? a?.voting_method) !== 'top2') fail(409, '투표 방식이 바뀌었습니다. 화면을 새로 고쳐 주세요.', 'voting_method_changed');
    if (!a?.started_at) continue;
    if ((edit.votingMethod !== null && edit.votingMethod !== a.voting_method) || (edit.rankPoints !== null && edit.rankPoints !== a.rank_points)) {
      fail(409, '투표 방식과 배점은 리셋한 뒤 변경할 수 있습니다.', 'voting_method_locked');
    }
  }
  return fail(409, '설정이 변경되었습니다. 화면을 새로 고쳐 주세요.', 'settings_conflict');
}
async function changeState(request: Request, env: Env, id: ActivityId, admin: Session) {
  const data = await body(request); let sql: string;
  const revision = requestRevision(data.revision);
  if (data.action === 'open') {
    sql = "UPDATE activities SET status='open',started_at=coalesce(started_at,?) WHERE id=? AND published=0 AND results_locked=0 AND status IN ('waiting','closed') AND EXISTS(SELECT 1 FROM candidates)";
    sql += " AND (voting_method<>'top2' OR (SELECT count(*) FROM candidates)>=json_array_length(rank_points))";
  }
  else if (data.action === 'close') sql = "UPDATE activities SET status='closed',published=publish_on_close WHERE id=? AND published=0 AND status='open'";
  else if (data.action === 'publish') sql = "UPDATE activities SET published=1 WHERE id=? AND status='closed' AND published=0";
  else return fail(400, '상태 변경을 확인해 주세요.');
  const startedAt = data.action === 'open' ? [new Date().toISOString()] : [];
  const result = await env.DB.prepare(`${sql} AND revision=? AND ${activeAdmin}`)
    .bind(...startedAt, id, revision, admin.token_hash, Date.now()).run();
  if (!result.meta.changes) {
    await requireAdmin(request, env);
    sameRevision(await activity(env, id), revision);
    fail(409, '현재 상태에서는 변경할 수 없습니다. 등록된 후보와 투표 방식을 확인해 주세요.', 'state_conflict');
  }
  return ok();
}
async function resetActivities(request: Request, env: Env, admin: Session, id?: ActivityId) {
  const data = await body(request);
  if (data.confirm !== 'reset') fail(400, '이벤트 리셋을 확인해 주세요.');
  const reset = "UPDATE activities SET status='waiting',published=0,publish_on_close=0,started_at=NULL,revision=revision+1";
  const activityIds = ids;
  let changed: D1Result;
  if (id) {
    changed = await env.DB.prepare(`${reset} WHERE id=? AND revision=? AND ${activeAdmin} RETURNING id`)
      .bind(id, revisionNumber(data.expectedRevision), admin.token_hash, Date.now()).all();
  } else {
    const revisions = data.expectedRevisions;
    if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) fail(400, '각 이벤트의 회차를 확인해 주세요.');
    const expected = revisions as Record<string, unknown>;
    changed = await env.DB.prepare(`WITH rounds AS MATERIALIZED (
        SELECT id FROM activities WHERE ${activityIds.map(() => '(id=? AND revision=?)').join(' OR ')}
      ) ${reset} WHERE id IN (SELECT id FROM rounds WHERE (SELECT count(*) FROM rounds)=?)
        AND ${activeAdmin} RETURNING id`)
      .bind(...activityIds.flatMap(key => [key, revisionNumber(expected[key])]), activityIds.length, admin.token_hash, Date.now()).all();
  }
  if (changed.results.length !== (id ? 1 : activityIds.length)) {
    await requireAdmin(request, env);
    fail(409, '이벤트 회차가 바뀌었습니다. 화면을 새로 고쳐 주세요.', 'revision_changed');
  }
  return ok();
}
async function resetRankedVote(request: Request, env: Env, admin: Session) {
  const data = await body(request);
  if (data.confirm !== 'reset-all') fail(400, '현재 투표 전체 초기화를 확인해 주세요.');
  const revision = revisionNumber(data.expectedRevision), rosterRevision = revisionNumber(data.expectedRosterRevision);
  const rosterGuard = await sharedRosterGuard(env);
  const updated = await env.DB.prepare(`UPDATE activities SET status='waiting',published=0,publish_on_close=0,started_at=NULL,
    revision=revision+1,full_reset_revision=revision+1
    WHERE id='byob' AND revision=? AND EXISTS(SELECT 1 FROM event WHERE id=1 AND roster_revision=?)
    AND ${rosterGuard} AND ${activeAdmin} RETURNING revision`)
    .bind(revision, rosterRevision, admin.token_hash, Date.now()).first<{ revision: number }>();
  if (!updated) {
    await requireAdmin(request, env);
    sameRevision(await activity(env, 'byob'), revision);
    await requireExclusiveRoster(env, rosterGuard);
    fail(409, '참가자 명단이 바뀌었습니다. 다시 확인해 주세요.', 'roster_changed');
  }
  return json({ ok: true, revision: updated.revision, cleanupPending: await retryCandidatePhotoCleanup(env) });
}
async function addParticipants(request: Request, env: Env, admin: Session) {
  const data = await body(request); if (!Array.isArray(data.names) || data.names.length < 1 || data.names.length > 500) fail(400, '이름을 1~500개 입력해 주세요.');
  const created: Participant[] = [], duplicates: string[] = [], invalid: string[] = [];
  for (const value of data.names) { let name: string; try { name = normalizeName(value); } catch { invalid.push(typeof value === 'string' ? value.slice(0, 80) : ''); continue; }
    const id = crypto.randomUUID();
    const inserted = await env.DB.prepare(`INSERT INTO participants(id,name,name_key) SELECT ?,?,? WHERE ${activeAdmin} ON CONFLICT(name_key) DO NOTHING`)
      .bind(id, name, nameKey(name), admin.token_hash, Date.now()).run();
    if (inserted.meta.changes) created.push({ id, name });
    else { await requireAdmin(request, env); duplicates.push(name); }
  }
  return json({ created, duplicates, invalid });
}
async function renameParticipant(request: Request, env: Env, id: string, admin: Session) {
  const data = await body(request), name = normalizeName(data.name);
  const updated = await env.DB.prepare(`UPDATE participants SET name=?,name_key=? WHERE id=? AND ${activeAdmin}`)
    .bind(name, nameKey(name), id, admin.token_hash, Date.now()).run();
  if (!updated.meta.changes) {
    await requireAdmin(request, env);
    fail(404, '참가자가 없습니다.');
  }
  return ok();
}
async function deleteParticipants(request: Request, env: Env, admin: Session, id?: string) {
  const data = await body(request);
  if (data.confirm !== 'delete') fail(400, '참가자 삭제를 확인해 주세요.');
  const now = Date.now();
  const rosterGuard = await sharedRosterGuard(env);
  const removed = id
    ? await env.DB.prepare(`DELETE FROM participants WHERE id=? AND ${rosterGuard} AND ${activeAdmin}`).bind(id, admin.token_hash, now).run()
    : await env.DB.prepare(`WITH selection AS MATERIALIZED (
        SELECT participants.id FROM participants CROSS JOIN event WHERE event.id=1 AND roster_revision=? AND ${rosterGuard} AND ${activeAdmin}
      ) DELETE FROM participants WHERE id IN (SELECT id FROM selection)`)
      .bind(revisionNumber(data.expectedRosterRevision), admin.token_hash, now).run();
  if (!removed.meta.changes) {
    await requireAdmin(request, env);
    await requireExclusiveRoster(env, rosterGuard);
    if (id) fail(404, '참가자가 없습니다.', 'participant_not_found');
    fail(409, '참가자 명단이 바뀌었거나 비어 있습니다. 다시 확인해 주세요.', 'roster_changed');
  }
  return ok();
}
async function sharedRosterGuard(env: Env) {
  const legacyGrades = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='grades'").first();
  return noOtherActivityData + (legacyGrades ? ' AND NOT EXISTS(SELECT 1 FROM grades)' : '');
}
async function requireExclusiveRoster(env: Env, guard: string) {
  if (!await env.DB.prepare(`SELECT 1 AS safe WHERE ${guard}`).first()) {
    fail(409, '다른 활동의 기록이 있어 참가자를 삭제할 수 없습니다.', 'shared_activity_data');
  }
}
function imageType(bytes: Uint8Array) {
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v) && new TextDecoder().decode(bytes.slice(12,16)) === 'IHDR') return 'image/png';
  if (bytes.length >= 30 && new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP' && ['VP8 ','VP8L','VP8X'].includes(new TextDecoder().decode(bytes.slice(12,16)))) return 'image/webp';
  return fail(415, 'JPEG, PNG, WebP 사진만 등록할 수 있습니다.');
}
async function addCandidate(request: Request, env: Env, admin: Session) {
  const contentType = request.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  let data: Record<string, unknown>, form: FormData | undefined;
  if (mediaType === 'application/json') {
    data = await body(request);
  } else if (mediaType === 'multipart/form-data') {
    const bytes = await boundedBody(request, MAX_PHOTO + 16384);
    try {
      form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': contentType }, body: bytes.buffer as ArrayBuffer }).formData();
    } catch { return fail(400, '사진 요청을 확인해 주세요.'); }
    const formRevision = form.get('revision');
    if (formRevision !== null && (typeof formRevision !== 'string' || !/^\d+$/.test(formRevision))) fail(400, '회차 정보를 확인해 주세요.');
    data = { name: form.get('name'), requestId: form.get('requestId'), revision: formRevision === null ? 0 : Number(formRevision) };
  } else {
    return fail(415, '와인 등록 요청의 형식을 확인해 주세요.');
  }
  const name = text(data.name, '와인명', 160), requestId = text(data.requestId, '요청 ID', 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) fail(400, '요청 ID를 확인해 주세요.');
  const revision = revisionNumber(data.revision);
  const a = await activity(env, 'byob');
  sameRevision(a, revision);
  const lookup = () => env.DB.prepare(`SELECT * FROM candidates WHERE request_id=?
    AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=?) AND ${activeAdmin}`)
    .bind(requestId, revision, admin.token_hash, Date.now());
  const existing = await lookup().first<Candidate>();
  if (existing) return json({ candidate: candidatePublic(existing), reused: true });
  if (a.started_at) fail(409, '투표 시작 후 후보를 변경할 수 없습니다.', 'candidates_locked');
  const id = crypto.randomUUID();
  let key = '', photoType = '';
  if (form) {
    const file = form.get('file');
    if (!(file instanceof File) || !file.size || file.size > MAX_PHOTO) fail(413, '사진은 5MB 이하로 등록해 주세요.');
    const content = new Uint8Array(await file.arrayBuffer());
    photoType = imageType(content);
    if (file.type !== photoType) fail(415, '사진 내용과 형식이 일치하지 않습니다.');
    key = `candidates/${id}`;
    await env.PHOTOS.put(key, content, { httpMetadata: { contentType: photoType } });
  }
  try {
    await env.DB.prepare(`INSERT INTO candidates(id,number,name,object_key,content_type,request_id)
      SELECT ?,coalesce((SELECT max(number) FROM candidates),0)+1,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL) AND ${activeAdmin}
      ON CONFLICT(request_id) DO NOTHING`).bind(id, name, key, photoType, requestId, revision, admin.token_hash, Date.now()).run();
    const saved = await lookup().first<Candidate>();
    if (!saved) {
      await requireAdmin(request, env);
      sameRevision(await activity(env, 'byob'), revision);
      fail(409, '투표가 시작되어 후보를 추가할 수 없습니다.', 'candidates_locked');
    }
    if (key && saved.id !== id) await env.PHOTOS.delete(key);
    return json({ candidate: candidatePublic(saved), reused: saved.id !== id });
  } catch (error) {
    // A failed response can follow a committed INSERT; preserve its object on ambiguous DB failures.
    if (key) {
      try {
        const committed = await env.DB.prepare(`SELECT 1 FROM candidates WHERE object_key=?
          UNION ALL SELECT 1 FROM vote_history h CROSS JOIN json_each(h.snapshot,'$.rows') c
          WHERE json_extract(c.value,'$.object_key')=? LIMIT 1`).bind(key, key).first();
        if (!committed) {
          try { await env.PHOTOS.delete(key); }
          catch {
            await env.DB.prepare('INSERT OR IGNORE INTO candidate_photo_cleanup(object_key) VALUES(?)').bind(key).run();
          }
        }
      } catch { /* Preserve the object until reconciliation is possible. */ }
    }
    throw error;
  }
}
async function changeCandidate(request: Request, env: Env, id: string, admin: Session) {
  const data = await body(request), name = text(data.name, '와인명', 160), revision = requestRevision(data.revision);
  const result = await env.DB.prepare(`UPDATE candidates SET name=? WHERE id=?
    AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL) AND ${activeAdmin}`)
    .bind(name, id, revision, admin.token_hash, Date.now()).run();
  if (!result.meta.changes) {
    await requireAdmin(request, env);
    sameRevision(await activity(env, 'byob'), revision);
    fail(409, '후보가 없거나 투표가 이미 시작되었습니다.', 'candidates_locked');
  }
  return ok();
}
async function renameCandidates(request: Request, env: Env, admin: Session) {
  const data = await body(request);
  const revision = requestRevision(data.revision);
  if (!Array.isArray(data.names) || !data.names.length) fail(400, '저장할 와인 이름을 확인해 주세요.');
  const names = data.names.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '후보 정보를 확인해 주세요.');
    const edit = value as Record<string, unknown>;
    if (typeof edit.id !== 'string' || !edit.id.length || edit.id.length > 80 || edit.id.trim() !== edit.id) fail(400, '후보 ID를 확인해 주세요.');
    return { id: edit.id, name: text(edit.name, '와인명', 160) };
  });
  if (new Set(names.map(edit => edit.id)).size !== names.length) fail(400, '같은 후보가 두 번 포함되어 있습니다.');
  const updated = await env.DB.prepare(`WITH edits AS MATERIALIZED (
      SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.name') AS name FROM json_each(?)
    ) UPDATE candidates SET name=(SELECT edits.name FROM edits WHERE edits.id=candidates.id)
    WHERE id IN (SELECT id FROM edits)
      AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL)
      AND ${activeAdmin}
      AND (SELECT count(*) FROM edits JOIN candidates c ON c.id=edits.id)=(SELECT count(*) FROM edits)
    RETURNING id`).bind(JSON.stringify(names), revision, admin.token_hash, Date.now()).all<{ id: string }>();
  if (updated.results.length !== names.length) {
    await requireAdmin(request, env);
    const current = await activity(env, 'byob');
    sameRevision(current, revision);
    if (current.started_at) fail(409, '투표 시작 후 후보를 변경할 수 없습니다.', 'candidates_locked');
    fail(409, '후보 목록이 변경되었습니다. 화면을 새로 고쳐 주세요.', 'candidate_list_changed');
  }
  return ok();
}
async function reorderCandidates(request: Request, env: Env, admin: Session) {
  const data = await body(request); if (!Array.isArray(data.ids) || data.ids.length > 200 || data.ids.some(id => typeof id !== 'string') || new Set(data.ids).size !== data.ids.length) fail(400, '후보 순서를 확인해 주세요.');
  const list = data.ids as string[];
  const revision = requestRevision(data.revision);
  const encoded = JSON.stringify(list);
  const result = await env.DB.prepare(`UPDATE candidates SET number=(SELECT CAST(key AS INTEGER)+1 FROM json_each(?) WHERE value=candidates.id)
    WHERE EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL)
      AND (SELECT count(*) FROM candidates)=json_array_length(?)
      AND NOT EXISTS(SELECT 1 FROM candidates WHERE id NOT IN (SELECT value FROM json_each(?)))
      AND ${activeAdmin}`).bind(encoded, revision, encoded, encoded, admin.token_hash, Date.now()).run();
  if (result.meta.changes !== list.length || !list.length) {
    await requireAdmin(request, env);
    const current = await activity(env, 'byob');
    sameRevision(current, revision);
    if (list.length || current.started_at || (await candidates(env)).length) fail(409, '후보 목록이 변경되었거나 투표가 시작되었습니다.', 'candidates_locked');
  }
  return ok();
}
async function deleteCandidate(request: Request, env: Env, id: string, admin: Session) {
  const revision = requestRevision(request.body ? (await body(request)).revision : undefined);
  const authorization = [admin.token_hash, Date.now()];
  const batch = await env.DB.batch([
    env.DB.prepare(`DELETE FROM candidates WHERE id=? AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL)
      AND ${activeAdmin} RETURNING object_key`).bind(id, revision, ...authorization),
    env.DB.prepare(`WITH ordering AS MATERIALIZED (SELECT id,row_number() OVER (ORDER BY number,id) AS n FROM candidates)
      UPDATE candidates SET number=(SELECT n FROM ordering WHERE ordering.id=candidates.id)
      WHERE EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL) AND ${activeAdmin}`).bind(revision, ...authorization)
  ]);
  const removed = batch[0].results[0] as { object_key: string } | undefined;
  if (!removed) {
    await requireAdmin(request, env);
    sameRevision(await activity(env, 'byob'), revision);
    fail(409, '후보가 없거나 투표가 이미 시작되었습니다.', 'candidates_locked');
  }
  if (removed.object_key) {
    const pending = await env.DB.prepare('SELECT object_key FROM candidate_photo_cleanup WHERE object_key=?').bind(removed.object_key).first();
    if (pending) await removeCandidatePhotos(env, [removed.object_key]);
  }
  return ok();
}
async function removeCandidatePhotos(env: Env, keys: string[]) {
  if (!keys.length) return;
  const photoKeys = keys.filter(Boolean);
  if (photoKeys.length) await env.PHOTOS.delete(photoKeys);
  await env.DB.prepare('DELETE FROM candidate_photo_cleanup WHERE object_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(keys)).run();
}
function candidatePhotoCleanupCount(env: Env) {
  return env.DB.prepare('SELECT count(*) AS count FROM candidate_photo_cleanup');
}
async function retryCandidatePhotoCleanup(env: Env) {
  const pending = await env.DB.prepare('SELECT object_key FROM candidate_photo_cleanup ORDER BY object_key LIMIT 1000').all<{ object_key: string }>();
  try { await removeCandidatePhotos(env, pending.results.map(row => row.object_key)); }
  catch { /* Keep the deletion keys available for retry. */ }
  return (await candidatePhotoCleanupCount(env).first<number>('count')) ?? 0;
}
async function resetCandidates(request: Request, env: Env, admin: Session) {
  const data = await body(request);
  if (data.confirm !== 'reset-wines') fail(400, '와인 후보 초기화를 확인해 주세요.');
  const revision = revisionNumber(data.revision);
  const guard = `${activeAdmin}
    AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL AND status='waiting' AND published=0)
    AND NOT EXISTS(SELECT 1 FROM answers WHERE activity_id='byob')`;
  const bindings = [admin.token_hash, Date.now(), revision];
  const [removed, updated] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM candidates WHERE ${guard} RETURNING object_key`).bind(...bindings),
    env.DB.prepare(`UPDATE activities SET revision=revision+1 WHERE id='byob' AND ${guard} RETURNING revision`).bind(...bindings)
  ]);
  const next = updated.results[0] as { revision: number } | undefined;
  if (!next) {
    await requireAdmin(request, env);
    sameRevision(await activity(env, 'byob'), revision);
    fail(409, '투표 시작 후 후보를 변경할 수 없습니다.', 'candidates_locked');
  }
  return json({ ok: true, deleted: removed.results.length, revision: next.revision, cleanupPending: await retryCandidatePhotoCleanup(env) });
}
async function photo(request: Request, env: Env, id: string) {
  const a = await activity(env, 'byob');
  const publiclyVisible = a.status === 'open' || Boolean(a.published);
  if (!publiclyVisible && !await session(request, env, 'admin')) fail(403, '사진이 아직 공개되지 않았습니다.');
  const c = await env.DB.prepare('SELECT * FROM candidates WHERE id=?').bind(id).first<Candidate>(); if (!c?.object_key) fail(404, '사진이 없습니다.');
  const object = await env.PHOTOS.get(c.object_key); if (!object) fail(404, '사진이 없습니다.');
  if (publiclyVisible) {
    const current = await activity(env, 'byob');
    if (current.revision !== a.revision || (current.status !== 'open' && !current.published)) {
      await object.body.cancel();
      fail(403, '사진이 아직 공개되지 않았습니다.');
    }
  }
  return new Response(object.body, { headers: { 'Content-Type': c.content_type, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' } });
}
async function participantLogin(request: Request, env: Env) {
  await rateLimit(request, env, 'participant', 120);
  const data = await body(request);
  const name = normalizeName(data.name);
  const key = nameKey(name);
  const lookup = env.DB.prepare('SELECT id,name FROM participants WHERE name_key=?').bind(key);
  let participant = await lookup.first<Participant>();
  if (!participant) {
    const created = await env.DB.prepare(`INSERT INTO participants(id,name,name_key) SELECT ?,?,?
      WHERE EXISTS(SELECT 1 FROM event WHERE id=1 AND participation_mode='open')
      ON CONFLICT(name_key) DO NOTHING RETURNING id,name`).bind(crypto.randomUUID(), name, key).first<Participant>();
    participant = created ?? await lookup.first<Participant>();
  }
  if (!participant) fail(404, '등록된 이름을 확인해 주세요.', 'participant_not_found');
  return json({ participant }, 200, { 'Set-Cookie': await createSession(request, env, 'participant', participant.id) });
}

async function assetResponse(request: Request, env: Env, path: string) {
  const versioned = path === '/assets' || path.startsWith('/assets/');
  if (!versioned && (request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since'))) {
    const headers = new Headers(request.headers);
    headers.delete('If-None-Match');
    headers.delete('If-Modified-Since');
    request = new Request(request, { headers });
  }
  const response = await env.ASSETS.fetch(request);
  const html = response.headers.get('Content-Type')?.includes('text/html');
  if (html && (versioned || path === '/startup.js')) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  }
  if (!html && path !== '/startup.js') return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname, method = request.method;
  if (!path.startsWith('/api/')) return assetResponse(request, env, path);
  if (!['GET', 'HEAD'].includes(method)) sameOrigin(request);
  if (path === '/api/mode' && method === 'GET') return json({ mode: 'ranked-byob' });
  if (path === '/api/session') {
    if (method === 'POST') return participantLogin(request, env);
    if (method === 'DELETE') return revoke(request, env, 'participant');
  }
  if (path === '/api/admin/login' && method === 'POST') { await rateLimit(request, env, 'admin', 8); const data = await body(request); const password = typeof data.password === 'string' && data.password.length <= 1024 ? data.password : fail(400, '비밀번호를 확인해 주세요.'); const verified=await verifyPassword(password, env);if (!verified.valid) fail(401, '비밀번호가 일치하지 않습니다.', 'invalid_password'); return json({ ok: true }, 200, { 'Set-Cookie': await createSession(request, env, 'admin', null,verified.version) }); }
  if (path === '/api/admin/session' && method === 'DELETE') { await requireAdmin(request, env); return revoke(request, env, 'admin'); }
  if (path === '/api/bootstrap' && method === 'GET') return bootstrap(request, env);
  const match = /^\/api\/(activities|results)\/([^/]+)(\/answer)?$/.exec(path);
  if (match) { const id = activityId(match[2]); if (match[1] === 'results' && !match[3] && method === 'GET') return results(env, id); if (match[1] === 'activities' && match[3] && method === 'PUT') return submit(request, env, id); if (match[1] === 'activities' && !match[3] && method === 'GET') return detail(request, env, id); }
  if (path.startsWith('/api/photos/') && method === 'GET') return photo(request, env, path.slice('/api/photos/'.length));
  if (path.startsWith('/api/admin/')) {
    const admin=await requireAdmin(request, env);
    if (path === '/api/admin/history' && method === 'GET') return historyList(env);
    if (path === '/api/admin/history' && method === 'POST') return saveHistory(request, env, admin);
    const historyMatch = /^\/api\/admin\/history\/([^/]+)(?:\/photos\/([^/]+))?$/.exec(path);
    if (historyMatch && method === 'GET') return historyMatch[2] ? historyPhoto(env, historyMatch[1], historyMatch[2]) : historyDetail(env, historyMatch[1]);
    if (historyMatch && !historyMatch[2] && ['PUT', 'DELETE'].includes(method)) return changeHistory(request, env, admin, historyMatch[1]);
    if (path === '/api/admin/reset-all' && method === 'POST') return resetRankedVote(request, env, admin);
    if(path==='/api/admin/password' && method==='POST')return changePassword(request,env,admin);
    if (path === '/api/admin/state' && method === 'GET') return adminState(request, env);
    if (path === '/api/admin/sessions' && method === 'DELETE') return revoke(request, env, 'admin', true);
    if (path === '/api/admin/event' && method === 'PATCH') return updateEvent(request, env, admin);
    if (path === '/api/admin/settings' && method === 'PATCH') return updateSettings(request, env, admin);
    if (path === '/api/admin/reset' && method === 'POST') return resetActivities(request, env, admin);
    if (path === '/api/admin/participants') {
      if (method === 'POST') return addParticipants(request, env, admin);
      if (method === 'DELETE') return deleteParticipants(request, env, admin);
    }
    const participantMatch = /^\/api\/admin\/participants\/([^/]+)$/.exec(path);
    if (participantMatch) {
      if (method === 'PATCH') return renameParticipant(request, env, participantMatch[1], admin);
      if (method === 'DELETE') return deleteParticipants(request, env, admin, participantMatch[1]);
    }
    const activityMatch = /^\/api\/admin\/activities\/([^/]+)(\/state|\/reset)?$/.exec(path);
    if (activityMatch) {
      const id = activityId(activityMatch[1]);
      if (!activityMatch[2] && method === 'PATCH') return configure(request, env, id, admin);
      if (activityMatch[2] === '/state' && method === 'POST') return changeState(request, env, id, admin);
      if (activityMatch[2] === '/reset' && method === 'POST') return resetActivities(request, env, admin, id);
    }
    if (path === '/api/admin/candidates' && method === 'POST') return addCandidate(request, env, admin);
    if (path === '/api/admin/candidates/reset' && method === 'POST') return resetCandidates(request, env, admin);
    if (path === '/api/admin/candidates/cleanup' && method === 'POST') return json({ ok: true, cleanupPending: await retryCandidatePhotoCleanup(env) });
    if (path === '/api/admin/candidates/names' && method === 'PUT') return renameCandidates(request, env, admin);
    if (path === '/api/admin/candidates/order' && method === 'PUT') return reorderCandidates(request, env, admin);
    const candidateMatch = /^\/api\/admin\/candidates\/([^/]+)$/.exec(path); if (candidateMatch) { if (method === 'PATCH') return changeCandidate(request, env, candidateMatch[1], admin); if (method === 'DELETE') return deleteCandidate(request, env, candidateMatch[1], admin); }
  }
  return fail(404, '요청한 경로가 없습니다.', 'not_found');
}
function errorResponse(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
  const message = error instanceof Error ? error.message : '';
  const conflict = /UNIQUE constraint|candidates_locked|activity_closed|candidate_missing|credential_changed/.test(message);
  return json({ error: conflict ? '현재 상태와 충돌합니다. 화면을 새로 고쳐 주세요.' : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', code: conflict ? 'conflict' : 'server_error' }, conflict ? 409 : 500);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    const path = new URL(request.url).pathname;
    try { response = await route(request, env); }
    catch (error) { response = errorResponse(error); }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'same-origin');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
    if (path.startsWith('/api/')) { headers.set('Cache-Control','no-store'); headers.set('Pragma','no-cache'); }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
