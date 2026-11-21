import type { Env } from './index';
import type { MemberSession } from './members';
import { ownerPollSlug } from './members';
import { ensureWorkspace, workspaceDatabase, workspaceDeleted, type Workspace } from './workspaces';

const tables = ['event','answers','sessions','participant_entries','participant_round_entries','participants','activities','vote_history','candidates','candidate_photo_cleanup','login_attempts','admin_credentials','admin_bootstrap_history'];
const json = (value:unknown,status=200) => Response.json(value,{status});
const missing = () => json({error:'투표를 찾을 수 없습니다.',code:'not_found'},404);

async function cleanupPhotos(env:Env,workspace:Workspace) {
  if(!workspace.namespace)return;
  workspaceDatabase(env.DB,workspace);
  const version=await env.DB.prepare('SELECT cleanup_version FROM member_polls WHERE slug=? AND deleted_at IS NOT NULL AND cleanup_pending=1').bind(workspace.slug).first<number>('cleanup_version');
  if(version===null)return;
  const prefix=`members/${workspace.namespace}/`;
  // Only this dedicated prefix belongs exclusively to the deleted poll, including archived photos.
  const page=await env.PHOTOS.list({prefix,limit:1000});
  if(page.objects.length)await env.PHOTOS.delete(page.objects.map(object=>object.key));
  if(!(await env.PHOTOS.list({prefix,limit:1})).objects.length)await env.DB.prepare('UPDATE member_polls SET cleanup_pending=0 WHERE slug=? AND deleted_at IS NOT NULL AND cleanup_version=?').bind(workspace.slug,version).run();
}

export async function retryDeletedPollPhotos(env:Env) {
  const rows=await env.DB.prepare('SELECT slug,namespace FROM member_polls WHERE deleted_at IS NOT NULL AND namespace IS NOT NULL AND cleanup_pending=1 ORDER BY deleted_at,slug LIMIT 5').all<Workspace>();
  for(const row of rows.results){
    try{await cleanupPhotos(env,row);}catch{/* The durable tombstone remains eligible for the next sweep. */}
  }
}

export async function deleteMemberPoll(env:Env,member:MemberSession,slug:string,data:Record<string,unknown>) {
  if(member.status!=='approved')return json({error:'승인된 회원 로그인이 필요합니다.',code:'unauthorized'},403);
  if(data.confirm!=='delete-poll')return json({error:'투표 삭제를 확인해 주세요.',code:'invalid_request'},400);
  const publicSlug=slug;
  if(slug==='owner')return missing();
  if(member.role==='owner' && slug===await ownerPollSlug(env))slug='owner';
  const row=await env.DB.prepare('SELECT slug,namespace,deleted_at FROM member_polls WHERE slug=? AND member_id=?').bind(slug,member.id).first<Workspace & {deleted_at:number|null}>();
  if(!row)return missing();
  if(row.namespace && row.deleted_at===null)await ensureWorkspace(env,row);
  const now=Date.now();
  const active=`EXISTS(SELECT 1 FROM members m JOIN member_sessions s ON s.member_id=m.id
    WHERE m.id=? AND m.status='approved' AND s.token_hash=? AND s.expires_at>?
      AND ((m.role='member' AND s.credential_version=m.credential_version)
        OR (m.role='owner' AND EXISTS(SELECT 1 FROM admin_credentials WHERE id=1 AND version=s.credential_version))))`;
  if(row.deleted_at!==null){
    if(!await env.DB.prepare(`SELECT 1 WHERE ${active}`).bind(member.id,member.tokenHash,now).first())return json({error:'회원 로그인이 필요합니다.',code:'unauthorized'},401);
    return json({ok:true,slug:publicSlug});
  }
  const authorize=()=>env.DB.prepare(`UPDATE member_polls SET deleted_at=coalesce(deleted_at,?),creation_title='',cleanup_pending=CASE WHEN namespace IS NULL THEN 0 ELSE 1 END,cleanup_version=cleanup_version+1
    WHERE slug=? AND member_id=? AND ${active} RETURNING slug`).bind(now,slug,member.id,member.id,member.tokenHash,now);
  const statements:D1PreparedStatement[]=[];
  if(row.namespace){
    const names=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?").bind(`${row.namespace}_%`).all<{name:string}>()).results;
    const present=new Set(names.map(item=>item.name));
    workspaceDatabase(env.DB,row);
    for(const table of tables){
      if(!present.has(`${row.namespace}_${table}`) || table==='candidate_photo_cleanup')continue;
      for(const operation of ['INSERT','UPDATE'])statements.push(env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS ${row.namespace}_deleted_${table}_${operation}
        BEFORE ${operation} ON ${row.namespace}_${table} WHEN EXISTS(SELECT 1 FROM member_polls WHERE slug='${slug}' AND deleted_at IS NOT NULL)
        BEGIN SELECT RAISE(ABORT,'poll_deleted'); END`));
    }
    statements.push(authorize());
    for(const table of tables)if(present.has(`${row.namespace}_${table}`))statements.push(env.DB.prepare(`DELETE FROM ${row.namespace}_${table} WHERE EXISTS(SELECT 1 FROM member_polls WHERE slug=? AND member_id=? AND deleted_at IS NOT NULL) AND ${active}`).bind(slug,member.id,member.id,member.tokenHash,now));
    // Install this fence after candidate deletion has finished using its cleanup enqueue trigger.
    if(present.has(`${row.namespace}_candidate_photo_cleanup`))for(const operation of ['INSERT','UPDATE'])statements.push(env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS ${row.namespace}_deleted_candidate_photo_cleanup_${operation}
      BEFORE ${operation} ON ${row.namespace}_candidate_photo_cleanup WHEN EXISTS(SELECT 1 FROM member_polls WHERE slug='${slug}' AND deleted_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'poll_deleted'); END`));
  }else{
    // shortcut: legacy owner tables and R2 keys are shared with older activities; retain them behind the permanent tombstone until an explicit ownership-aware purge is requested.
    statements.push(authorize());
  }
  await env.DB.batch(statements);
  // Checking the session again also covers a revoked repeated DELETE without erasing other polls' credentials.
  const valid=await env.DB.prepare(`SELECT 1 WHERE ${active}`).bind(member.id,member.tokenHash,Date.now()).first();
  if(!valid)return json({error:'회원 로그인이 필요합니다.',code:'unauthorized'},401);
  if(!await workspaceDeleted(env,row))return missing();
  try{await cleanupPhotos(env,row);}catch{/* The scheduled sweep retries deleted namespaces. */}
  return json({ok:true,slug:publicSlug});
}
