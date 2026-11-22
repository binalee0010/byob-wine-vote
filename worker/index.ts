import { PasswordVerifier } from './password-verifier';
import { getMemberSession, getWorkspaceBySlug, handleMemberRequest, type MemberSession } from './members';
import { ensureWorkspace, workspaceDeleted, workspaceEnv, workspacePhotoKey, type Workspace } from './workspaces';
import { retryDeletedPollPhotos } from './poll-deletion';
import { retryPendingNotices } from './signup-mail';
import { notifyBuildFailures } from './build-failures';
import { ensurePublicPollLink } from './public-links';
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
  SUPERADMIN_EMAIL?: string;
  MEMBERSHIP_REQUIRED?: string;
  SMTP_CONFIG?: string;
  WORKSPACE?: Workspace;
  MEMBER_SESSION?: MemberSession;
  MEMBER_DB?: D1Database;
}

type ActivityId = 'byob';
type VotingMethod = 'winner' | 'top2' | 'full';
type ParticipationMode = 'open' | 'restricted';
type ResultVisibility = 'private' | 'participants' | 'public';
type Activity = { id: ActivityId; title: string; status: 'waiting' | 'open' | 'closed'; published: number; publish_on_close: number; started_at: string | null; revision: number; results_locked: number; result_visibility: ResultVisibility; voting_method?: VotingMethod; rank_points?: string };
type Participant = { id: string; name: string };
type Candidate = { id: string; number: number; name: string; description?: string; object_key: string; content_type: string; request_id: string };
type RankedCandidate = Candidate & { score: number };
type Session = { role: 'admin' | 'participant'; participant_id: string | null; token_hash: string };
const ids: ActivityId[] = ['byob'];
const encoder = new TextEncoder();
const MAX_PHOTO = 5 * 1024 * 1024;
function memberAuthorization(env: Env) {
  const member = env.MEMBER_SESSION;
  if (!member || !/^[a-f0-9]{64}$/.test(member.tokenHash)) return '0';
  const namespace = env.WORKSPACE?.namespace;
  if (namespace && !/^m_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid internal workspace');
  const owner = env.WORKSPACE?.memberId;
  if (owner && owner !== 'owner' && !/^[a-f0-9]{32}$/.test(owner)) throw new Error('Invalid internal workspace owner');
  return `EXISTS(SELECT 1 FROM member_sessions ms JOIN members m ON m.id=ms.member_id
    WHERE ms.token_hash='${member.tokenHash}' AND ms.expires_at>${Date.now()} AND m.status='approved'
    AND ((m.role='member' AND ms.credential_version=m.credential_version)
      OR m.role='owner')
    AND ${owner ? `m.id='${owner}'` : `m.namespace ${namespace ? `='${namespace}'` : 'IS NULL'}`})
    AND NOT EXISTS(SELECT 1 FROM member_polls WHERE slug='${env.WORKSPACE?.slug ?? 'owner'}' AND deleted_at IS NOT NULL)`;
}
function activeAdmin(env: Env) {
  const local = "EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND role='admin' AND expires_at>?)";
  return env.SUPERADMIN_EMAIL ? `(?='${env.MEMBER_SESSION?.tokenHash ?? ''}' AND ?>0) AND ${memberAuthorization(env)}` : local;
}
function activePoll(env:Env) {return env.SUPERADMIN_EMAIL && env.WORKSPACE?`NOT EXISTS(SELECT 1 FROM member_polls WHERE slug='${env.WORKSPACE.slug}' AND deleted_at IS NOT NULL)`:'1';}
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
    started: a.started_at !== null, revision: a.revision, resultVisibility: a.result_visibility,
    votingMethod: publicVotingMethod(a.voting_method), rankPoints: rankPoints(a) };
}
function apiPath(env: Env, path: string) { return `${env.WORKSPACE ? `/v/${env.WORKSPACE.publicAlias ?? env.WORKSPACE.publicSlug ?? env.WORKSPACE.slug}` : ''}/api${path}`; }
function candidatePublic(c: Pick<Candidate, 'id' | 'number' | 'name' | 'description' | 'object_key'>, env: Env) {
  const version=/\/photos\/([a-f0-9]{32})\/[A-Za-z0-9_-]{8,80}$/.exec(c.object_key)?.[1];
  return { id: c.id, number: c.number, name: c.name, description: c.description ?? '', photoUrl: c.object_key ? apiPath(env, `/photos/${c.id}`)+(version?`?v=${version}`:'') : null };
}
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
  if (role === 'admin' && env.SUPERADMIN_EMAIL) {
    const member = env.MEMBER_SESSION ?? await getMemberSession(request, env);
    if (member?.status !== 'approved' || (env.WORKSPACE?.memberId ? member.id !== env.WORKSPACE.memberId : member.namespace !== (env.WORKSPACE?.namespace ?? null))) return null;
    const valid = await env.DB.prepare(`SELECT 1 WHERE ${memberAuthorization({ ...env, MEMBER_SESSION: member })}`).first();
    return valid ? { role: 'admin', participant_id: null, token_hash: member.tokenHash } : null;
  }
  const token = readCookie(request, cookieName(env, role)); if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const version=role==='admin'?await credentialVersion(env):null;
  const memberGuard = role === 'admin' && env.SUPERADMIN_EMAIL ? ` AND ${memberAuthorization(env)}` : '';
  return env.DB.prepare(`SELECT role,participant_id,token_hash FROM sessions WHERE token_hash=? AND role=? AND expires_at>? AND(role='participant' OR credential_version=?)${memberGuard}`).bind(await digest(token), role, Date.now(),version).first<Session>();
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
  if (all && env.SUPERADMIN_EMAIL) {
    const member = env.MEMBER_SESSION ?? fail(401, '회원 로그인이 필요합니다.', 'unauthorized');
    const authorized = `WITH authorized AS MATERIALIZED (SELECT 1 WHERE ${memberAuthorization(env)})`;
    await env.DB.batch([
      env.DB.prepare(`${authorized} DELETE FROM sessions WHERE role='admin' AND EXISTS(SELECT 1 FROM authorized)`),
      env.DB.prepare(`${authorized} DELETE FROM member_sessions WHERE member_id=? AND EXISTS(SELECT 1 FROM authorized)`).bind(member.id)
    ]);
    const headers = new Headers({ 'Set-Cookie': sessionCookie(env, role, '', 0) });
    headers.append('Set-Cookie', '__Host-byob_member=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    return json({ ok: true }, 200, headers);
  }
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
  if (env.SUPERADMIN_EMAIL && env.WORKSPACE?.namespace) {
    return (await env.DB.prepare('SELECT version FROM admin_credentials WHERE id=1').first<{version:string}>())?.version
      ?? fail(503, '회원 투표 세션 설정을 확인해 주세요.', 'admin_unconfigured');
  }
  const response=await passwordService(env,'/state');
  if (!response.ok) fail(503, '관리자 비밀번호 설정을 확인해 주세요.', 'admin_unconfigured');
  return ((await response.json()) as {version:string}).version;
}
async function verifyPassword(password: string, env: Env) {
  const response=await passwordService(env,'/verify',{password});
  if(!response.ok)fail(503,'관리자 비밀번호 설정을 확인해 주세요.','admin_unconfigured');
  return await response.json() as {valid:boolean;version:string};
}
export async function legacyAdminCredential(env: Env) {
  const version = await credentialVersion({ ...env, WORKSPACE: undefined });
  const credential = await env.DB.prepare('SELECT password_hash FROM admin_credentials WHERE id=1').first<{password_hash:string}>();
  if (!credential) fail(503, '관리자 비밀번호 설정을 확인해 주세요.', 'admin_unconfigured');
  return { passwordHash: credential.password_hash, version };
}
export async function memberAdminSession(request: Request, env: Env, workspace: Workspace) {
  if(await workspaceDeleted(env,workspace))return sessionCookie(workspaceEnv(env,workspace),'admin','',0);
  await ensureWorkspace(env, workspace);
  const scoped = workspaceEnv(env, workspace);
  if (workspace.namespace) {
    await scoped.DB.prepare('INSERT OR IGNORE INTO admin_credentials(id,password_hash,bootstrap_fingerprint,version) VALUES(1,?,?,?)')
      .bind('membership-only', 'membership-only', crypto.randomUUID()).run();
  }
  return createSession(request, scoped, 'admin', null, await credentialVersion(scoped));
}
export async function revokeWorkspaceAdmins(env: Env, workspace: Workspace) {
  if (workspace.namespace && !await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(`${workspace.namespace}_sessions`).first()) return;
  await workspaceEnv(env, workspace).DB.prepare("DELETE FROM sessions WHERE role='admin'").run();
}
export async function revokeWorkspaceAdmin(request: Request, env: Env, workspace: Workspace) {
  const scoped = workspaceEnv(env, workspace);
  if (!workspace.namespace || await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(`${workspace.namespace}_sessions`).first()) {
    await scoped.DB.prepare("DELETE FROM sessions WHERE token_hash=? AND role='admin'").bind(await digest(readCookie(request, cookieName(scoped, 'admin')))).run();
  }
  return sessionCookie(scoped, 'admin', '', 0);
}
async function changePassword(request:Request,env:Env,admin:Session) {
  await rateLimit(request,env,'admin-password',8);
  const data=await body(request);
  if(typeof data.currentPassword!=='string' || !data.currentPassword.length || typeof data.newPassword!=='string' || !data.newPassword.length)fail(400,'현재 비밀번호와 새 비밀번호를 입력해 주세요.');
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
  return env.DB.prepare("SELECT title,starts_at AS startsAt,timezone,'open' AS participationMode FROM event WHERE id=1").first();
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
function rankedResults(rows: RankedCandidate[], method: VotingMethod, env: Env) {
  const ranked = rankRows(rows, row => row.score, true);
  return ranked.map(c => ({ ...candidatePublic(c, env), candidateId: c.id, rank: c.rank, ...(method === 'winner' ? { votes: c.score } : { points: c.score }) }));
}
async function bootstrap(request: Request, env: Env) {
  const [all, event, participantSession] = await Promise.all([
    activityRows(env).all<Activity>(), eventInfo(env), session(request, env, 'participant')
  ]);
  if (participantSession?.participant_id) await env.DB.prepare(`INSERT OR IGNORE INTO participant_round_entries(participant_id,revision)
    SELECT ?,revision FROM activities WHERE id='byob' AND status IN ('waiting','open') AND ${activeParticipant} AND ${activePoll(env)}`)
    .bind(participantSession.participant_id, participantSession.token_hash, participantSession.participant_id, Date.now()).run();
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
  const candidateRows = (await candidates(env)).map(c => candidatePublic(c, env));
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
    fail(400, '투표 방식에 맞는 와인을 한 번씩 선택해 주세요.', 'invalid_ranking');
  }
  let result: D1Result;
  try {
    result = await env.DB.prepare(`INSERT INTO answers(activity_id,participant_id,payload,updated_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM activities WHERE id=? AND revision=? AND status='open' AND published=0)
        AND EXISTS(SELECT 1 FROM participants WHERE id=?) AND ${activeParticipant} AND ${activePoll(env)}
      ON CONFLICT(activity_id,participant_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
      .bind(id, participant.id, JSON.stringify({ ranking }), new Date().toISOString(), id, revision, participant.id,
        participant.token_hash, participant.id, Date.now()).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('candidate_missing')) {
      fail(400, '투표 방식에 맞는 와인을 한 번씩 선택해 주세요.', 'invalid_ranking');
    }
    throw error;
  }
  if (!result.meta.changes) {
    sameRevision(await activity(env, id), revision);
    checkParticipantIdentity(participant.id, (await requireParticipant(request, env)).id);
    fail(409, '참여 상태나 와인이 변경되었습니다. 다시 확인해 주세요.', 'activity_closed');
  }
  return ok();
}
async function resultAccess(request: Request, env: Env, a: Activity): Promise<string | null> {
  if (a.status !== 'closed' || !a.published || a.result_visibility === 'private') fail(403, '결과가 아직 공개되지 않았습니다.', 'results_unpublished');
  if (a.result_visibility === 'public') return null;
  const participant = await session(request, env, 'participant');
  if (!participant?.participant_id || !await env.DB.prepare(`SELECT 1 FROM participant_round_entries e
    JOIN participants p ON p.id=e.participant_id JOIN activities a ON a.id='byob' AND a.revision=e.revision
    WHERE e.participant_id=? AND a.revision=? AND a.status='closed' AND a.published=1 AND a.result_visibility='participants'
      AND ${activeParticipant} AND ${activePoll(env)}`)
    .bind(participant.participant_id, a.revision, participant.token_hash, participant.participant_id, Date.now()).first()) {
    fail(403, '이 투표에 참여한 닉네임으로 입장해 주세요.', 'participant_required');
  }
  return participant.participant_id;
}
async function results(request: Request, env: Env, id: ActivityId) {
  const initial = await activity(env, id);
  await resultAccess(request, env, initial);
  const rows = (await env.DB.prepare(rankedCandidateSql).all<RankedCandidate>()).results;
  const current = await activity(env, id);
  if (current.revision !== initial.revision) fail(403, '결과가 아직 공개되지 않았습니다.', 'results_unpublished');
  const participantId = await resultAccess(request, env, current);
  return json({ id, title: current.title, mode: 'ranked-byob', votingMethod: publicVotingMethod(current.voting_method),
    revision: current.revision, ...(participantId ? { participantId } : {}), rows: rankedResults(rows, current.voting_method ?? 'full', env) });
}
async function participantUrl(request: Request, env: Env) {
  const configured = env.PUBLIC_ORIGIN;
  const path = env.WORKSPACE ? `/v/${await ensurePublicPollLink({DB:env.MEMBER_DB??env.DB},env.WORKSPACE)}` : '/';
  if (!configured) return new URL(path, request.url).href;
  try {
    const url = new URL(configured);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid origin');
    return new URL(path, url.origin).href;
  } catch { return fail(503, '참가 주소 설정을 확인해 주세요.', 'origin_unconfigured'); }
}
async function adminState(request: Request, env: Env) {
  const [event, activities, participants, candidateRows, cleanup, submissions] = await env.DB.batch([
    env.DB.prepare("SELECT title,memo,starts_at AS startsAt,timezone,'open' AS participationMode,roster_revision AS rosterRevision FROM event WHERE id=1"),
    env.DB.prepare("SELECT * FROM activities WHERE id='byob'"),
    env.DB.prepare("SELECT p.id,p.name,EXISTS(SELECT 1 FROM answers a WHERE a.activity_id='byob' AND a.participant_id=p.id) AS submitted FROM participants p JOIN participant_entries e ON e.participant_id=p.id ORDER BY p.name,p.id"),
    env.DB.prepare(rankedCandidateSql), candidatePhotoCleanupCount(env), env.DB.prepare("SELECT count(*) AS count FROM answers WHERE activity_id='byob'")
  ]);
  const { rosterRevision, ...metadata } = event.results[0] as { title: string; memo: string; startsAt: string; timezone: string; participationMode: ParticipationMode; rosterRevision: number };
  const activityList = activities.results as Activity[];
  return json({
    mode: 'ranked-byob', event: metadata, rosterRevision, participantUrl: await participantUrl(request, env),
    photoCleanupPending: (cleanup.results[0] as { count: number }).count,
    activities: activityList.map(a => ({ ...activityPublic(a), resultsLocked: Boolean(a.results_locked) })),
    participants: (participants.results as {id:string;name:string;submitted:number}[]).map(person => ({id:person.id,name:person.name,submitted:{byob:Boolean(person.submitted)}})),
    submittedCount: (submissions.results[0] as {count:number}).count,
    answers: {byob:(participants.results as {id:string;submitted:number}[]).filter(person => person.submitted).map(person => ({participantId:person.id}))},
    candidates: (candidateRows.results as Candidate[]).map(c => candidatePublic(c, env)),
    byobResults: rankedResults(candidateRows.results as RankedCandidate[], activityList[0]?.voting_method ?? 'full', env)
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
  const updated = await env.DB.prepare(`UPDATE event SET title=?,starts_at=?,timezone='Asia/Seoul' WHERE id=1 AND ${activeAdmin(env)}`)
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
    AND ${activeAdmin(env)}`)
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
  let title: string | null = null, startsAt: string | null = null, memo: string | null = null;
  if (data.event !== undefined) {
    if (!data.event || typeof data.event !== 'object' || Array.isArray(data.event)) fail(400, '행사 설정을 확인해 주세요.');
    const event = data.event as Record<string, unknown>;
    if (event.timezone !== undefined && event.timezone !== 'Asia/Seoul') fail(400, '한국 시간의 유효한 행사 일시를 입력해 주세요.');
    if (event.title !== undefined) title = text(event.title, '행사명', 160);
    if (event.memo !== undefined) {
      if (typeof event.memo !== 'string' || event.memo.length > 2000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(event.memo)) fail(400, '메모 내용을 확인해 주세요.');
      memo = event.memo;
    }
    if (event.startsAt !== undefined) startsAt = eventStartTime(event.startsAt);
    if (event.participationMode !== undefined) {
      if (event.participationMode !== 'open') fail(400, '이름을 입력해 자유롭게 참여하는 투표입니다.', 'invalid_participation_mode');
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
    if (visibility !== undefined && visibility !== 'private' && visibility !== 'participants' && visibility !== 'public') {
      fail(400, '결과 공개 범위를 확인해 주세요.', 'invalid_result_visibility');
    }
    const publishOnClose = visibility === undefined ? null : Number(visibility !== 'private');
    if (publishOnClose === null && Object.values(settings).every(value => value === null)) fail(400, '저장할 이벤트 설정을 확인해 주세요.');
    return { id, revision: revisionNumber(entry.revision), publishOnClose, resultVisibility: visibility ?? null, ...settings };
  });
  if (new Set(edits.map(edit => edit.id)).size !== edits.length) fail(400, '같은 이벤트가 두 번 포함되어 있습니다.');
  const saveEvent = title !== null || startsAt !== null || memo !== null;
  if (!saveEvent && !edits.length && (data.event as Record<string, unknown> | undefined)?.participationMode === 'open') return ok();
  if (!saveEvent && !edits.length) fail(400, '저장할 설정을 확인해 주세요.');
  const encoded = JSON.stringify(edits);
  const pending = `WITH edits AS MATERIALIZED (
    SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.revision') AS revision,
      json_extract(value,'$.title') AS title,json_extract(value,'$.votingMethod') AS voting_method,
      json_extract(value,'$.rankPoints') AS rank_points,json_extract(value,'$.publishOnClose') AS publish_on_close,json_extract(value,'$.resultVisibility') AS result_visibility FROM json_each(?)
  )`;
  // Each statement uses the same guard. Accepted updates cannot change any of its conditions.
  const guard = `${activeAdmin(env)} AND EXISTS(SELECT 1 FROM event WHERE id=1) AND NOT EXISTS (
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
    UPDATE event SET title=coalesce(?,title),starts_at=coalesce(?,starts_at),memo=coalesce(?,memo)
    WHERE id=1 AND ${guard} RETURNING id`)
    .bind(encoded, title, startsAt, memo, admin.token_hash, now));
  if (edits.length) statements.push(env.DB.prepare(`${pending}
    UPDATE activities SET title=coalesce((SELECT e.title FROM edits e WHERE e.id=activities.id),title),
      result_visibility=coalesce((SELECT e.result_visibility FROM edits e WHERE e.id=activities.id),result_visibility),
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
  else if (data.action === 'publish') sql = "UPDATE activities SET published=1,result_visibility='public' WHERE id=? AND status='closed' AND published=0";
  else return fail(400, '상태 변경을 확인해 주세요.');
  const startedAt = data.action === 'open' ? [new Date().toISOString()] : [];
  const result = await env.DB.prepare(`${sql} AND revision=? AND ${activeAdmin(env)}`)
    .bind(...startedAt, id, revision, admin.token_hash, Date.now()).run();
  if (!result.meta.changes) {
    await requireAdmin(request, env);
    sameRevision(await activity(env, id), revision);
    fail(409, '현재 상태에서는 변경할 수 없습니다. 등록된 와인과 투표 방식을 확인해 주세요.', 'state_conflict');
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
    changed = await env.DB.prepare(`${reset} WHERE id=? AND revision=? AND ${activeAdmin(env)} RETURNING id`)
      .bind(id, revisionNumber(data.expectedRevision), admin.token_hash, Date.now()).all();
  } else {
    const revisions = data.expectedRevisions;
    if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) fail(400, '각 이벤트의 회차를 확인해 주세요.');
    const expected = revisions as Record<string, unknown>;
    changed = await env.DB.prepare(`WITH rounds AS MATERIALIZED (
        SELECT id FROM activities WHERE ${activityIds.map(() => '(id=? AND revision=?)').join(' OR ')}
      ) ${reset} WHERE id IN (SELECT id FROM rounds WHERE (SELECT count(*) FROM rounds)=?)
        AND ${activeAdmin(env)} RETURNING id`)
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
    AND ${rosterGuard} AND ${activeAdmin(env)} RETURNING revision`)
    .bind(revision, rosterRevision, admin.token_hash, Date.now()).first<{ revision: number }>();
  if (!updated) {
    await requireAdmin(request, env);
    sameRevision(await activity(env, 'byob'), revision);
    await requireExclusiveRoster(env, rosterGuard);
    fail(409, '참여 현황이 바뀌었습니다. 다시 확인해 주세요.', 'roster_changed');
  }
  return json({ ok: true, revision: updated.revision, cleanupPending: await retryCandidatePhotoCleanup(env) });
}
async function sharedRosterGuard(env: Env) {
  if (env.WORKSPACE?.namespace) return noOtherActivityData;
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
    data = { name: form.get('name'), description: form.get('description') ?? '', requestId: form.get('requestId'), revision: formRevision === null ? 0 : Number(formRevision) };
  } else {
    return fail(415, '와인 등록 요청의 형식을 확인해 주세요.');
  }
  const name = form && data.name === null ? null : text(data.name, '와인 이름', 160), requestId = text(data.requestId, '요청 ID', 80);
  const description = text(data.description ?? '', '와인 설명', 2000, false);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) fail(400, '요청 ID를 확인해 주세요.');
  const revision = revisionNumber(data.revision);
  const a = await activity(env, 'byob');
  sameRevision(a, revision);
  const lookup = () => env.DB.prepare(`SELECT * FROM candidates WHERE request_id=?
    AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=?) AND ${activeAdmin(env)}`)
    .bind(requestId, revision, admin.token_hash, Date.now());
  const existing = await lookup().first<Candidate>();
  if (existing) return json({ candidate: candidatePublic(existing, env), reused: true });
  if (a.started_at) fail(409, '투표 시작 후 와인을 변경할 수 없습니다.', 'candidates_locked');
  const id = crypto.randomUUID();
  let key = '', photoType = '';
  if (form) {
    const file = form.get('file');
    if (!(file instanceof File) || !file.size || file.size > MAX_PHOTO) fail(413, '사진은 5MB 이하로 등록해 주세요.');
    const content = new Uint8Array(await file.arrayBuffer());
    photoType = imageType(content);
    if (file.type !== photoType) fail(415, '사진 내용과 형식이 일치하지 않습니다.');
    key = workspacePhotoKey(env.WORKSPACE, `candidates/${id}`);
    await env.PHOTOS.put(key, content, { httpMetadata: { contentType: photoType } });
  }
  try {
    await env.DB.prepare(`INSERT INTO candidates(id,number,name,description,object_key,content_type,request_id)
      SELECT ?,next_number,coalesce(?,'와인 ' || printf('%02d',next_number)),?,?,?,?
      FROM (SELECT coalesce(max(number),0)+1 AS next_number FROM candidates)
      WHERE EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL) AND ${activeAdmin(env)}
      ON CONFLICT(request_id) DO NOTHING`).bind(id, name, description, key, photoType, requestId, revision, admin.token_hash, Date.now()).run();
    const saved = await lookup().first<Candidate>();
    if (!saved) {
      await requireAdmin(request, env);
      sameRevision(await activity(env, 'byob'), revision);
      fail(409, '투표가 시작되어 와인을 추가할 수 없습니다.', 'candidates_locked');
    }
    if (key && saved.id !== id) await env.PHOTOS.delete(key);
    return json({ candidate: candidatePublic(saved, env), reused: saved.id !== id });
  } catch (error) {
    // A failed response can follow a committed INSERT; preserve its object on ambiguous DB failures.
    if (key) {
      try {
        const committed = await env.DB.prepare('SELECT 1 FROM candidates WHERE object_key=?').bind(key).first();
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
async function replaceCandidatePhoto(request:Request,env:Env,id:string,admin:Session) {
  const contentType=request.headers.get('content-type')??'';
  if(contentType.split(';',1)[0].trim().toLowerCase()!=='multipart/form-data')fail(415,'사진 요청의 형식을 확인해 주세요.');
  const bytes=await boundedBody(request,MAX_PHOTO+16384);
  let form:FormData;
  try{form=await new Request(request.url,{method:'POST',headers:{'Content-Type':contentType},body:bytes.buffer as ArrayBuffer}).formData();}
  catch{return fail(400,'사진 요청을 확인해 주세요.');}
  const round=form.get('revision');if(typeof round!=='string' || !/^\d+$/.test(round))fail(400,'회차 정보를 확인해 주세요.');
  const revision=revisionNumber(Number(round)),requestId=text(form.get('requestId'),'요청 ID',80),expected=form.get('expectedPhotoUrl'),file=form.get('file');
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(requestId) || typeof expected!=='string' || expected.length>512)fail(400,'사진 변경 정보를 확인해 주세요.');
  if(!(file instanceof File) || !file.size || file.size>MAX_PHOTO)fail(413,'사진은 5MB 이하로 등록해 주세요.');
  const content=new Uint8Array(await file.arrayBuffer()),contentTypePhoto=imageType(content);
  if(file.type!==contentTypePhoto)fail(415,'사진 내용과 형식이 일치하지 않습니다.');
  sameRevision(await activity(env,'byob'),revision);
  const original=await env.DB.prepare('SELECT * FROM candidates WHERE id=?').bind(id).first<Candidate>();
  if(!original)fail(404,'와인이 없습니다.','not_found');
  const reused=(candidate:Candidate)=>(candidate.object_key.includes(`/candidates/${id}/photos/`) || candidate.object_key.startsWith(`candidates/${id}/photos/`))
    && candidate.object_key.endsWith(`/${requestId}`);
  if(reused(original))return json({ok:true,candidate:candidatePublic(original,env),reused:true});
  if((candidatePublic(original,env).photoUrl??'')!==expected)fail(409,'사진이 변경되었습니다. 화면을 새로 고쳐 주세요.','photo_changed');
  const version=Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,'0')).join('');
  const key=workspacePhotoKey(env.WORKSPACE,`candidates/${id}/photos/${version}/${requestId}`);
  try{
    await env.PHOTOS.put(key,content,{httpMetadata:{contentType:contentTypePhoto}});
    const saved=await env.DB.prepare(`UPDATE candidates SET object_key=?,content_type=? WHERE id=? AND object_key=?
      AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=?) AND ${activeAdmin(env)} RETURNING *`)
      .bind(key,contentTypePhoto,id,original.object_key,revision,admin.token_hash,Date.now()).first<Candidate>();
    if(!saved){
      await requireAdmin(request,env);sameRevision(await activity(env,'byob'),revision);
      const current=await env.DB.prepare('SELECT * FROM candidates WHERE id=?').bind(id).first<Candidate>();
      if(current && reused(current)){await removeCandidatePhotos(env,[key]);return json({ok:true,candidate:candidatePublic(current,env),reused:true});}
      fail(409,'사진이 변경되었습니다. 화면을 새로 고쳐 주세요.','photo_changed');
    }
    return json({ok:true,candidate:candidatePublic(saved,env),cleanupPending:await retryCandidatePhotoCleanup(env)});
  }catch(error){
    // The UPDATE may have committed even when its response failed; referenced objects must survive.
    try{await removeCandidatePhotos(env,[key]);}
    catch{try{await env.DB.prepare(`INSERT OR IGNORE INTO candidate_photo_cleanup(object_key) SELECT ?
      WHERE NOT EXISTS(SELECT 1 FROM candidates WHERE object_key=?)
      AND NOT EXISTS(SELECT 1 FROM vote_history h CROSS JOIN json_each(h.snapshot,'$.rows') c WHERE json_extract(c.value,'$.object_key')=?)`).bind(key,key,key).run();}catch{/* Preserve the object if reference checks are unavailable. */}}
    throw error;
  }
}
async function changeCandidate(request: Request, env: Env, id: string, admin: Session) {
  const data = await body(request), revision = requestRevision(data.revision);
  const original = await env.DB.prepare('SELECT name,description FROM candidates WHERE id=?').bind(id).first<Candidate>();
  const name = original && data.name === original.name ? original.name : text(data.name, '와인 이름', 160);
  const description = data.description === undefined ? null : original && data.description === original.description ? original.description! : text(data.description, '와인 설명', 2000, false);
  const result = await env.DB.prepare(`UPDATE candidates SET name=?,description=coalesce(?,description) WHERE id=?
    AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND (started_at IS NULL OR status='closed')) AND ${activeAdmin(env)}`)
    .bind(name, description, id, revision, admin.token_hash, Date.now()).run();
  if (!result.meta.changes) {
    await requireAdmin(request, env);
    sameRevision(await activity(env, 'byob'), revision);
    fail(409, '와인이 없거나 투표가 이미 시작되었습니다.', 'candidates_locked');
  }
  return ok();
}
async function renameCandidates(request: Request, env: Env, admin: Session) {
  const data = await body(request, 2 * 1024 * 1024);
  const revision = requestRevision(data.revision);
  if (!Array.isArray(data.names) || !data.names.length) fail(400, '저장할 와인 이름을 확인해 주세요.');
  const originals = new Map((await candidates(env)).map(candidate => [candidate.id,candidate]));
  const names = data.names.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '와인 정보를 확인해 주세요.');
    const edit = value as Record<string, unknown>;
    if (typeof edit.id !== 'string' || !edit.id.length || edit.id.length > 80 || edit.id.trim() !== edit.id) fail(400, '와인 ID를 확인해 주세요.');
    const original = originals.get(edit.id);
    return { id: edit.id, name: original && edit.name === original.name ? original.name : text(edit.name, '와인 이름', 160), ...(edit.description === undefined ? {} : {description:original && edit.description === original.description ? original.description : text(edit.description, '와인 설명', 2000, false)}) };
  });
  if (new Set(names.map(edit => edit.id)).size !== names.length) fail(400, '같은 와인이 두 번 포함되어 있습니다.');
  const updated = await env.DB.prepare(`WITH edits AS MATERIALIZED (
      SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.name') AS name,json_extract(value,'$.description') AS description FROM json_each(?)
    ) UPDATE candidates SET name=(SELECT edits.name FROM edits WHERE edits.id=candidates.id),
      description=coalesce((SELECT edits.description FROM edits WHERE edits.id=candidates.id),description)
    WHERE id IN (SELECT id FROM edits)
      AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND (started_at IS NULL OR status='closed'))
      AND ${activeAdmin(env)}
      AND (SELECT count(*) FROM edits JOIN candidates c ON c.id=edits.id)=(SELECT count(*) FROM edits)
    RETURNING id`).bind(JSON.stringify(names), revision, admin.token_hash, Date.now()).all<{ id: string }>();
  if (updated.results.length !== names.length) {
    await requireAdmin(request, env);
    const current = await activity(env, 'byob');
    sameRevision(current, revision);
    if (current.started_at && current.status !== 'closed') fail(409, '투표 마감 후 와인 정보를 수정해 주세요.', 'candidates_locked');
    fail(409, '와인 목록이 변경되었습니다. 화면을 새로 고쳐 주세요.', 'candidate_list_changed');
  }
  return ok();
}
async function reorderCandidates(request: Request, env: Env, admin: Session) {
  const data = await body(request); if (!Array.isArray(data.ids) || data.ids.length > 200 || data.ids.some(id => typeof id !== 'string') || new Set(data.ids).size !== data.ids.length) fail(400, '와인 순서를 확인해 주세요.');
  const list = data.ids as string[];
  const revision = requestRevision(data.revision);
  const encoded = JSON.stringify(list);
  const result = await env.DB.prepare(`UPDATE candidates SET number=(SELECT CAST(key AS INTEGER)+1 FROM json_each(?) WHERE value=candidates.id)
    WHERE EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL)
      AND (SELECT count(*) FROM candidates)=json_array_length(?)
      AND NOT EXISTS(SELECT 1 FROM candidates WHERE id NOT IN (SELECT value FROM json_each(?)))
      AND ${activeAdmin(env)}`).bind(encoded, revision, encoded, encoded, admin.token_hash, Date.now()).run();
  if (result.meta.changes !== list.length || !list.length) {
    await requireAdmin(request, env);
    const current = await activity(env, 'byob');
    sameRevision(current, revision);
    if (list.length || current.started_at || (await candidates(env)).length) fail(409, '와인 목록이 변경되었거나 투표가 시작되었습니다.', 'candidates_locked');
  }
  return ok();
}
async function deleteCandidate(request: Request, env: Env, id: string, admin: Session) {
  const revision = requestRevision(request.body ? (await body(request)).revision : undefined);
  const authorization = [admin.token_hash, Date.now()];
  const batch = await env.DB.batch([
    env.DB.prepare(`DELETE FROM candidates WHERE id=? AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL)
      AND ${activeAdmin(env)} RETURNING object_key`).bind(id, revision, ...authorization),
    env.DB.prepare(`WITH ordering AS MATERIALIZED (SELECT id,row_number() OVER (ORDER BY number,id) AS n FROM candidates)
      UPDATE candidates SET number=(SELECT n FROM ordering WHERE ordering.id=candidates.id)
      WHERE EXISTS(SELECT 1 FROM activities WHERE id='byob' AND revision=? AND started_at IS NULL) AND ${activeAdmin(env)}`).bind(revision, ...authorization)
  ]);
  const removed = batch[0].results[0] as { object_key: string } | undefined;
  if (!removed) {
    await requireAdmin(request, env);
    sameRevision(await activity(env, 'byob'), revision);
    fail(409, '와인이 없거나 투표가 이미 시작되었습니다.', 'candidates_locked');
  }
  if (removed.object_key) {
    const pending = await env.DB.prepare('SELECT object_key FROM candidate_photo_cleanup WHERE object_key=?').bind(removed.object_key).first();
    if (pending) await removeCandidatePhotos(env, [removed.object_key]);
  }
  return ok();
}
async function removeCandidatePhotos(env: Env, keys: string[]) {
  if (!keys.length) return;
  const photoKeys = (await env.DB.prepare(`SELECT keys.value AS object_key FROM json_each(?) keys WHERE keys.value<>''
    AND NOT EXISTS(SELECT 1 FROM candidates WHERE object_key=keys.value)
    AND NOT EXISTS(SELECT 1 FROM vote_history h CROSS JOIN json_each(h.snapshot,'$.rows') c WHERE json_extract(c.value,'$.object_key')=keys.value)`)
    .bind(JSON.stringify(keys)).all<{object_key:string}>()).results.map(row=>row.object_key);
  if (photoKeys.length) await env.PHOTOS.delete(photoKeys);
  await env.DB.prepare('DELETE FROM candidate_photo_cleanup WHERE object_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(photoKeys)).run();
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
  if (data.confirm !== 'reset-wines') fail(400, '와인 초기화를 확인해 주세요.');
  const revision = revisionNumber(data.revision);
  const guard = `${activeAdmin(env)}
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
    fail(409, '투표 시작 후 와인을 변경할 수 없습니다.', 'candidates_locked');
  }
  return json({ ok: true, deleted: removed.results.length, revision: next.revision, cleanupPending: await retryCandidatePhotoCleanup(env) });
}
async function photo(request: Request, env: Env, id: string) {
  const a = await activity(env, 'byob');
  const admin = await session(request, env, 'admin');
  if (!admin && a.status !== 'open') await resultAccess(request, env, a);
  const c = await env.DB.prepare('SELECT * FROM candidates WHERE id=?').bind(id).first<Candidate>(); if (!c?.object_key) fail(404, '사진이 없습니다.');
  const object = await env.PHOTOS.get(c.object_key); if (!object) fail(404, '사진이 없습니다.');
  try {
    const current = await activity(env, 'byob');
    if (current.revision !== a.revision) fail(403, '사진이 아직 공개되지 않았습니다.');
    if (admin) await requireAdmin(request, env);
    else if (current.status !== 'open') await resultAccess(request, env, current);
  } catch (error) { await object.body.cancel(); throw error; }
  return new Response(object.body, { headers: { 'Content-Type': c.content_type, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' } });
}
async function participantLogin(request: Request, env: Env) {
  await rateLimit(request, env, 'participant', 120);
  const data = await body(request);
  const name = normalizeName(data.name);
  const key = nameKey(name);
  const joinable = `EXISTS(SELECT 1 FROM activities a WHERE a.id='byob' AND (a.status<>'closed' OR EXISTS(
    SELECT 1 FROM participant_round_entries e JOIN participants p ON p.id=e.participant_id
    WHERE e.revision=a.revision AND p.name_key=?)))`;
  const canJoin = () => env.DB.prepare(`SELECT 1 WHERE ${joinable}`).bind(key).first();
  if (!await canJoin()) fail(403, '이 투표에 참여한 닉네임으로 입장해 주세요.', 'participant_not_entered');
  const token = randomToken(), hash = await digest(token), seconds = 30 * 24 * 3600, now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE (token_hash=? OR expires_at<=?) AND ${activePoll(env)} AND ${joinable}`).bind(await digest(readCookie(request, cookieName(env, 'participant'))), now, key),
    env.DB.prepare(`INSERT INTO participants(id,name,name_key) SELECT ?,?,? WHERE ${activePoll(env)} AND EXISTS(SELECT 1 FROM activities WHERE id='byob' AND status<>'closed') ON CONFLICT(name_key) DO NOTHING`).bind(crypto.randomUUID(), name, key),
    env.DB.prepare(`INSERT INTO sessions(token_hash,role,participant_id,expires_at,credential_version) SELECT ?,'participant',id,?,NULL FROM participants WHERE name_key=? AND ${activePoll(env)} AND ${joinable}`).bind(hash, now + seconds * 1000, key, key)
  ]);
  const participant = await env.DB.prepare('SELECT p.id,p.name FROM participants p JOIN sessions s ON s.participant_id=p.id WHERE s.token_hash=?').bind(hash).first<Participant>();
  if (!participant) {
    if (!await canJoin()) fail(403, '이 투표에 참여한 닉네임으로 입장해 주세요.', 'participant_not_entered');
    fail(409, '참여 상태가 바뀌었습니다. 이름을 다시 입력해 주세요.', 'participant_changed');
  }
  return json({ participant }, 200, { 'Set-Cookie': sessionCookie(env, 'participant', token, seconds) });
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
  if (path === '/api/admin/login' && method === 'POST') { await rateLimit(request, env, 'admin', 8); const data = await body(request); const password = typeof data.password === 'string' && data.password.length > 0 ? data.password : fail(400, '비밀번호를 확인해 주세요.'); const verified=await verifyPassword(password, env);if (!verified.valid) fail(401, '비밀번호가 일치하지 않습니다.', 'invalid_password'); return json({ ok: true }, 200, { 'Set-Cookie': await createSession(request, env, 'admin', null,verified.version) }); }
  if (path === '/api/admin/session' && method === 'DELETE') { await requireAdmin(request, env); return revoke(request, env, 'admin'); }
  if (path === '/api/bootstrap' && method === 'GET') return bootstrap(request, env);
  const match = /^\/api\/(activities|results)\/([^/]+)(\/answer)?$/.exec(path);
  if (match) { const id = activityId(match[2]); if (match[1] === 'results' && !match[3] && method === 'GET') return results(request, env, id); if (match[1] === 'activities' && match[3] && method === 'PUT') return submit(request, env, id); if (match[1] === 'activities' && !match[3] && method === 'GET') return detail(request, env, id); }
  if (path.startsWith('/api/photos/') && method === 'GET') return photo(request, env, path.slice('/api/photos/'.length));
  if (path.startsWith('/api/admin/')) {
    const admin=await requireAdmin(request, env);
    if (path === '/api/admin/reset-all' && method === 'POST') return resetRankedVote(request, env, admin);
    if(path==='/api/admin/password' && method==='POST')return changePassword(request,env,admin);
    if (path === '/api/admin/state' && method === 'GET') return adminState(request, env);
    if (path === '/api/admin/sessions' && method === 'DELETE') return revoke(request, env, 'admin', true);
    if (path === '/api/admin/event' && method === 'PATCH') return updateEvent(request, env, admin);
    if (path === '/api/admin/settings' && method === 'PATCH') return updateSettings(request, env, admin);
    if (path === '/api/admin/reset' && method === 'POST') return resetActivities(request, env, admin);
    if (path === '/api/admin/participants' || path.startsWith('/api/admin/participants/')) fail(410, '참가자는 이름을 직접 입력하며, 관리자는 제출 여부만 확인할 수 있습니다.', 'roster_read_only');
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
    const photoMatch=/^\/api\/admin\/candidates\/([^/]+)\/photo$/.exec(path);if(photoMatch && method==='PUT')return replaceCandidatePhoto(request,env,photoMatch[1],admin);
    const candidateMatch = /^\/api\/admin\/candidates\/([^/]+)$/.exec(path); if (candidateMatch) { if (method === 'PATCH') return changeCandidate(request, env, candidateMatch[1], admin); if (method === 'DELETE') return deleteCandidate(request, env, candidateMatch[1], admin); }
  }
  return fail(404, '요청한 경로가 없습니다.', 'not_found');
}
function withPath(request: Request, path: string) {
  const url = new URL(request.url); url.pathname = path;
  return new Request(url, request);
}
async function memberRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/api/members' || path.startsWith('/api/members/')) {
    if (!['GET', 'HEAD'].includes(request.method)) sameOrigin(request);
    return await handleMemberRequest(request, env, ctx) ?? fail(404, '요청한 경로가 없습니다.', 'not_found');
  }
  if (path === '/api/mode' && request.method === 'GET') return json({ mode: 'ranked-byob', membership: true });
  if (/^\/admin\/p\/owner\/?$/.test(path)) return Response.redirect(new URL('/admin',request.url).href,302);
  const match = /^\/v\/([a-z0-9][a-z0-9-]{1,47})(\/api\/.*)?\/?$/.exec(path);
  let workspace: Workspace | undefined;
  let apiRequest = request;
  if (path.startsWith('/v/')) {
    if (!match) fail(404, '투표 주소가 없습니다.', 'not_found');
    workspace = await getWorkspaceBySlug(env, match[1]) ?? fail(404, '투표 주소가 없습니다.', 'not_found');
    if (!match[2]) return assetResponse(request, env, path);
    apiRequest = withPath(request, match[2]);
    if (match[2].startsWith('/api/members/')) fail(404, '요청한 경로가 없습니다.', 'not_found');
  }
  const api = new URL(apiRequest.url).pathname;
  let member: MemberSession | null = null;
  if (api.startsWith('/api/admin/')) {
    if (!['GET', 'HEAD'].includes(request.method)) sameOrigin(request);
    if (api === '/api/admin/login') fail(401, '회원 로그인이 필요합니다.', 'member_login_required');
    member = await getMemberSession(request, env);
    if (member?.status !== 'approved') fail(401, '승인된 회원 로그인이 필요합니다.', 'unauthorized');
    if (workspace && (workspace.memberId ? member.id !== workspace.memberId : member.namespace !== workspace.namespace || member.workspaceSlug !== workspace.slug)) fail(403, '다른 회원의 투표를 관리할 수 없습니다.', 'workspace_forbidden');
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('x-member-csrf') !== member.csrfToken) fail(403, '회원 계정이 변경되었습니다. 화면을 새로 고쳐 주세요.', 'csrf');
    workspace ??= await getWorkspaceBySlug(env,member.publicWorkspaceSlug??member.workspaceSlug) ?? fail(404,'투표 주소가 없습니다.','not_found');
    if (api === '/api/admin/password' || api === '/api/admin/session') {
      return await handleMemberRequest(withPath(request, api.replace('/api/admin/', '/api/members/')), env, ctx)
        ?? fail(404, '요청한 경로가 없습니다.', 'not_found');
    }
  }
  if(!workspace && api.startsWith('/api/'))fail(404,'투표 주소가 없습니다.','not_found');
  if (workspace) {
    await ensureWorkspace(env, workspace);
    let response:Response;
    try{response=await route(apiRequest, { ...workspaceEnv(env, workspace), MEMBER_DB: env.DB, ...(member ? { MEMBER_SESSION: member } : {}) });}
    catch(error){if(await workspaceDeleted(env,workspace))fail(404,'투표 주소가 없습니다.','not_found');throw error;}
    if(await workspaceDeleted(env,workspace)){await response.body?.cancel();fail(404,'투표 주소가 없습니다.','not_found');}
    return response;
  }
  return route(request, env);
}
function errorResponse(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
  const message = error instanceof Error ? error.message : '';
  if(/poll_deleted/.test(message))return json({error:'투표 주소가 없습니다.',code:'not_found'},404);
  const conflict = /UNIQUE constraint|candidates_locked|activity_closed|candidate_missing|credential_changed/.test(message);
  return json({ error: conflict ? '현재 상태와 충돌합니다. 화면을 새로 고쳐 주세요.' : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', code: conflict ? 'conflict' : 'server_error' }, conflict ? 409 : 500);
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    let response: Response;
    const path = new URL(request.url).pathname;
    try {
      if (env.MEMBERSHIP_REQUIRED === 'true' && !env.SUPERADMIN_EMAIL?.trim()) fail(503, '회원 서비스 설정을 확인해 주세요.', 'members_unconfigured');
      response = await (env.SUPERADMIN_EMAIL ? memberRoute(request, env, ctx) : route(request, env));
    }
    catch (error) { response = errorResponse(error); }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
    if (path.startsWith('/api/') || /^\/v\/[^/]+\/api\//.test(path)) { headers.set('Cache-Control','no-store'); headers.set('Pragma','no-cache'); }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async queue(batch: MessageBatch<unknown>, env: Env) {
    await notifyBuildFailures(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (env.SUPERADMIN_EMAIL) {ctx.waitUntil(retryPendingNotices(env));ctx.waitUntil(retryDeletedPollPhotos(env));}
  }
};
