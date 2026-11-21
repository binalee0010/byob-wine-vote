import type { Env } from './index';
import type { MemberSession } from './members';
import { ensureWorkspace, workspaceDatabase, workspaceDeleted, workspaceSql, type Workspace } from './workspaces';

type PollRow = { slug:string; namespace:string|null; creation_title:string; initialized:number; deleted_at?:number|null };
const json = (data:unknown,status=200) => Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
async function publicPoll(env:Env,row:PollRow) {
  const db=workspaceDatabase(env.DB,row);
  const poll=await db.prepare("SELECT e.title,a.status FROM event e CROSS JOIN activities a WHERE e.id=1 AND a.id='byob'").first<{title:string;status:string}>();
  if(!poll)throw new Error('Missing poll workspace');
  return {slug:row.slug,...poll};
}
async function initializePoll(env:Env,row:PollRow) {
  if(row.initialized)return;
  await ensureWorkspace(env,row);
  const db=workspaceDatabase(env.DB,row);
  await env.DB.batch([
    db.prepare('UPDATE event SET title=? WHERE id=1 AND EXISTS(SELECT 1 FROM member_polls WHERE slug=? AND initialized=0)').bind(row.creation_title,row.slug),
    env.DB.prepare('UPDATE member_polls SET initialized=1 WHERE slug=? AND deleted_at IS NULL').bind(row.slug)
  ]);
}
async function registerLegacyPoll(env:Env,member:MemberSession) {
  const workspace:Workspace={slug:member.workspaceSlug,namespace:member.namespace};
  if(await env.DB.prepare('SELECT 1 FROM member_polls WHERE slug=?').bind(workspace.slug).first())return;
  if(workspace.namespace && !await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(`${workspace.namespace}_event`).first())return;
  const db=workspaceDatabase(env.DB,workspace);
  const row=await db.prepare(`SELECT e.title FROM event e WHERE e.id=1 AND (
    e.title NOT IN ('BYOB 와인 투표','투표','새 투표') OR e.starts_at<>'' OR e.participation_mode<>'open'
    OR EXISTS(SELECT 1 FROM participants) OR EXISTS(SELECT 1 FROM candidates)
    OR EXISTS(SELECT 1 FROM answers WHERE activity_id='byob') OR EXISTS(SELECT 1 FROM vote_history)
    OR EXISTS(SELECT 1 FROM activities WHERE id='byob' AND (started_at IS NOT NULL OR status<>'waiting' OR published<>0
      OR publish_on_close<>0 OR voting_method<>'full' OR rank_points<>'[3,1]'
      OR title NOT IN ('BYOB 와인 투표','투표','새 투표'))))`).first<{title:string}>();
  if(!row)return;
  await env.DB.prepare('INSERT OR IGNORE INTO member_polls(slug,member_id,namespace,request_id,creation_title,initialized,created_at) VALUES(?,?,?,NULL,?,1,?)')
    .bind(workspace.slug,member.id,workspace.namespace,row.title,Date.now()).run();
}
export async function memberPolls(request:Request,env:Env,member:MemberSession,readBody:()=>Promise<Record<string,unknown>>) {
  if(member.status!=='approved')return json({error:'승인된 회원 로그인이 필요합니다.',code:'unauthorized'},403);
  if(request.method==='GET') {
    await registerLegacyPoll(env,member);
    const rows=await env.DB.prepare('SELECT slug,namespace,creation_title,initialized FROM member_polls WHERE member_id=? AND deleted_at IS NULL ORDER BY created_at DESC,slug').bind(member.id).all<PollRow>();
    for(const row of rows.results)try{await initializePoll(env,row);}catch(error){if(!await workspaceDeleted(env,row))throw error;}
    const queries=[];
    // VALUES avoids D1's small compound SELECT limit while keeping bound parameters bounded.
    for(let index=0;index<rows.results.length;index+=50){
      const chunk=rows.results.slice(index,index+50);
      const value="(?,(SELECT title FROM event WHERE id=1),(SELECT status FROM activities WHERE id='byob'))";
      queries.push(env.DB.prepare(`SELECT column1 AS slug,column2 AS title,column3 AS status FROM (VALUES ${chunk.map(row=>row.namespace?workspaceSql(value,row.namespace):value).join(',')})`).bind(...chunk.map(row=>row.slug)));
    }
    const details=queries.length?(await env.DB.batch(queries)).flatMap(result=>result.results as {slug:string;title:string;status:string}[]):[];
    const bySlug=new Map(details.map(poll=>[poll.slug,poll]));
    const deleted=new Set((await env.DB.prepare('SELECT slug FROM member_polls WHERE member_id=? AND deleted_at IS NOT NULL').bind(member.id).all<{slug:string}>()).results.map(row=>row.slug));
    return json({polls:rows.results.filter(row=>!deleted.has(row.slug)).map(row=>{const poll=bySlug.get(row.slug);if(!poll)throw new Error('Missing poll workspace');return poll;})});
  }
  if(request.method!=='POST')return json({error:'요청을 찾을 수 없습니다.',code:'not_found'},404);
  const data=await readBody();
  const title=typeof data.title==='string'?data.title.normalize('NFKC').trim():'';
  if(!title || title.length>120 || /[\u0000-\u001f\u007f]/u.test(title))return json({error:'투표 이름을 확인해 주세요.',code:'invalid_request'},400);
  if(typeof data.requestId!=='string' || !/^[A-Za-z0-9_-]{8,80}$/.test(data.requestId))return json({error:'요청 ID를 확인해 주세요.',code:'invalid_request'},400);
  const slug=crypto.randomUUID().replaceAll('-','');
  const inserted=await env.DB.prepare(`INSERT INTO member_polls(slug,member_id,namespace,request_id,creation_title,created_at)
    SELECT ?,m.id,?,?,?,? FROM members m JOIN member_sessions s ON s.member_id=m.id
    WHERE m.id=? AND m.status='approved' AND s.token_hash=? AND s.expires_at>?
      AND ((m.role='member' AND s.credential_version=m.credential_version)
        OR (m.role='owner' AND EXISTS(SELECT 1 FROM admin_credentials WHERE id=1 AND version=s.credential_version)))
    ON CONFLICT(member_id,request_id) DO NOTHING`).bind(slug,`m_${slug}`,data.requestId,title,Date.now(),member.id,member.tokenHash,Date.now()).run();
  const row=await env.DB.prepare('SELECT slug,namespace,creation_title,initialized,deleted_at FROM member_polls WHERE member_id=? AND request_id=?').bind(member.id,data.requestId).first<PollRow>();
  if(!row)return json({error:'회원 로그인이 필요합니다.',code:'unauthorized'},401);
  if(row.deleted_at!==null && row.deleted_at!==undefined)return json({error:'삭제한 투표 요청입니다. 새 투표를 만들어 주세요.',code:'poll_deleted'},410);
  if(row.creation_title!==title)return json({error:'새 투표 요청으로 다시 시도해 주세요.',code:'request_id_reused'},409);
  await initializePoll(env,row);
  if(await workspaceDeleted(env,row))return json({error:'삭제한 투표 요청입니다. 새 투표를 만들어 주세요.',code:'poll_deleted'},410);
  return json({poll:await publicPoll(env,row)},inserted.meta.changes?201:200);
}
