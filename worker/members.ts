import type { Env } from './index';
import { legacyAdminCredential, memberAdminSession, revokeWorkspaceAdmin, revokeWorkspaceAdmins } from './index';
import { ensureWorkspace, type Workspace } from './workspaces';
import { retryPendingNotices } from './signup-mail';
import { confirmPasswordReset, PasswordResetError, requestPasswordReset } from './password-reset';
import { memberPolls } from './polls';
import { deleteMemberPoll } from './poll-deletion';

type MemberRow = { id:string; email:string; role:'owner'|'member'; status:'pending'|'approved'|'rejected'; workspace_slug:string; namespace:string|null; password_hash:string|null; credential_version:string|null; created_at:number; reviewed_at:number|null };
export type MemberSession = { id:string; email:string; role:MemberRow['role']; status:MemberRow['status']; workspaceSlug:string; namespace:string|null; csrfToken:string; tokenHash:string; credentialVersion:string };
const cookieName='__Host-byob_member', seconds=12*3600;
class MemberError extends Error { constructor(public status:number,message:string,public code='invalid_request'){super(message);} }
function fail(status:number,message:string,code?:string):never { throw new MemberError(status,message,code); }
const json=(data:unknown,status=200,headers?:HeadersInit)=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...Object.fromEntries(new Headers(headers))}});
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
async function digest(value:string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join(''); }
function cookie(request:Request) { return request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1)??''; }
function sessionCookie(value:string,age=seconds) { return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`; }
function email(value:unknown) {
  if(typeof value!=='string')return fail(400,'이메일을 확인해 주세요.');
  const result=value.trim().toLowerCase();
  if(result.length>254 || !/^[\x21-\x7e]+$/.test(result) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))fail(400,'이메일을 확인해 주세요.');
  return result;
}
function ownerEmail(env:Env) {
  if(!env.SUPERADMIN_EMAIL)fail(503,'관리자 이메일 설정을 확인해 주세요.','members_unconfigured');
  try{return email(env.SUPERADMIN_EMAIL);}catch{return fail(503,'관리자 이메일 설정을 확인해 주세요.','members_unconfigured');}
}
function password(value:unknown) {
  if(typeof value!=='string' || !value.length)fail(400,'비밀번호를 입력해 주세요.');
  return value;
}
function sameOrigin(request:Request) {
  if(request.headers.get('origin')!==new URL(request.url).origin || request.headers.get('sec-fetch-site')==='cross-site')fail(403,'같은 사이트에서 다시 요청해 주세요.','csrf');
}
async function body(request:Request):Promise<Record<string,unknown>> {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))fail(415,'JSON 요청이 필요합니다.');
  const reader=request.body?.getReader();let raw='';const decoder=new TextDecoder();let length=0;
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>4096){await reader.cancel();fail(413,'요청 크기가 너무 큽니다.');}raw+=decoder.decode(value,{stream:true});}
  raw+=decoder.decode();
  try{const result=JSON.parse(raw);if(result && typeof result==='object' && !Array.isArray(result))return result;}catch{/* invalid JSON */}
  return fail(400,'JSON 요청을 확인해 주세요.');
}
async function rateLimit(request:Request,env:Env,scope:string,limit:number,identity?:string) {
  const now=Date.now(),start=Math.floor(now/900000)*900000;
  const key=await digest(`${scope}:${identity??request.headers.get('cf-connecting-ip')??'local'}`);
  const row=await env.DB.prepare('INSERT INTO member_login_attempts(key,window_start,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start=excluded.window_start THEN attempts+1 ELSE 1 END,window_start=excluded.window_start RETURNING attempts').bind(key,start).first<{attempts:number}>();
  if(!row || row.attempts>limit)fail(429,'시도가 너무 많습니다. 15분 뒤 다시 시도해 주세요.','rate_limited');
}
async function passwordOperation<T>(env:Env,path:string,data:unknown):Promise<T> {
  const stub=env.PASSWORD_VERIFIER.get(env.PASSWORD_VERIFIER.idFromName('admin-password'));
  const response=await stub.fetch(`https://password.internal${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  if(!response.ok)fail(503,'비밀번호 검증 설정을 확인해 주세요.','admin_unconfigured');
  return await response.json() as T;
}
function workspace(member:Pick<MemberSession,'workspaceSlug'|'namespace'>):Workspace {return {slug:member.workspaceSlug,namespace:member.namespace};}
function publicMember(member:MemberSession) {return {id:member.id,email:member.email,role:member.role,status:member.status,workspaceSlug:member.workspaceSlug};}
function state(member:MemberSession|null) {return {authenticated:!!member,csrfToken:member?.csrfToken??null,member:member?publicMember(member):null};}

export async function getWorkspaceBySlug(env:Env,slug:string):Promise<Workspace|null> {
  if(slug!=='owner' && !/^[a-f0-9]{32}$/.test(slug))return null;
  if(await env.DB.prepare('SELECT 1 FROM member_polls WHERE slug=? AND deleted_at IS NOT NULL').bind(slug).first())return null;
  const poll=await env.DB.prepare("SELECT p.namespace,m.id,m.email,m.role FROM member_polls p JOIN members m ON m.id=p.member_id WHERE p.slug=? AND p.deleted_at IS NULL AND m.status='approved'").bind(slug).first<{namespace:string|null;id:string;email:string;role:string}>();
  if(poll)return poll.role==='owner' && poll.email!==ownerEmail(env)?null:{slug,namespace:poll.namespace,memberId:poll.id};
  if(slug==='owner'){ownerEmail(env);return {slug:'owner',namespace:null,memberId:'owner'};}
  const row=await env.DB.prepare("SELECT id,workspace_slug,namespace,email,role FROM members WHERE workspace_slug=? AND status='approved'").bind(slug).first<{id:string;workspace_slug:string;namespace:string|null;email:string;role:string}>();
  if(!row || (row.role==='owner' && row.email!==ownerEmail(env)))return null;
  return {slug:row.workspace_slug,namespace:row.namespace,memberId:row.id};
}
export async function getMemberSession(request:Request,env:Env):Promise<MemberSession|null> {
  if(env.MEMBER_DB)env={...env,DB:env.MEMBER_DB,WORKSPACE:undefined};
  const value=cookie(request);if(!/^[a-f0-9]{64}$/.test(value))return null;
  const configuredOwner=ownerEmail(env),tokenHash=await digest(value);
  const row=await env.DB.prepare('SELECT m.*,s.csrf_token,s.credential_version AS session_version FROM member_sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=? AND s.expires_at>?').bind(tokenHash,Date.now()).first<MemberRow & {csrf_token:string;session_version:string}>();
  if(!row)return null;
  const version=row.role==='owner'?(await legacyAdminCredential(env)).version:row.credential_version;
  if(row.session_version!==version || (row.role==='owner' && (row.email!==configuredOwner || row.status!=='approved')))return null;
  return {id:row.id,email:row.email,role:row.role,status:row.status,workspaceSlug:row.workspace_slug,namespace:row.namespace,csrfToken:row.csrf_token,tokenHash,credentialVersion:row.session_version};
}
function requireCsrf(request:Request,member:MemberSession) {if(request.headers.get('x-member-csrf')!==member.csrfToken)fail(403,'화면을 새로 고친 뒤 다시 요청해 주세요.','csrf');}
async function requireSession(request:Request,env:Env) {return await getMemberSession(request,env)??fail(401,'회원 로그인이 필요합니다.','unauthorized');}
async function createSession(request:Request,env:Env,row:MemberRow,version:string) {
  const value=token(),csrf=token(),hash=await digest(value);
  const results=await env.DB.batch([
    env.DB.prepare('DELETE FROM member_sessions WHERE token_hash=? OR expires_at<=?').bind(await digest(cookie(request)),Date.now()),
    env.DB.prepare(`INSERT INTO member_sessions(token_hash,member_id,credential_version,csrf_token,expires_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM members m WHERE m.id=? AND m.status=? AND ((m.role='member' AND m.credential_version=?) OR (m.role='owner' AND EXISTS(SELECT 1 FROM admin_credentials WHERE id=1 AND version=?))))`).bind(hash,row.id,version,csrf,Date.now()+seconds*1000,row.id,row.status,version,version)
  ]);
  if(!results[1].meta.changes)fail(409,'계정 정보가 변경되었습니다. 다시 로그인해 주세요.','credential_changed');
  const member:MemberSession={id:row.id,email:row.email,role:row.role,status:row.status,workspaceSlug:row.workspace_slug,namespace:row.namespace,csrfToken:csrf,tokenHash:hash,credentialVersion:version};
  const headers=new Headers({'Set-Cookie':sessionCookie(value)});
  if(member.status==='approved')headers.append('Set-Cookie',await memberAdminSession(request,env,workspace(member)));
  else headers.append('Set-Cookie',await revokeWorkspaceAdmin(request,env,workspace(member)));
  return {member,headers};
}
function sessionJson(member:MemberSession|null,status=200,headers?:HeadersInit) {
  const response=Response.json(state(member),{status,headers});response.headers.set('Cache-Control','no-store');return response;
}
async function signup(request:Request,env:Env,ctx?:ExecutionContext) {
  const adminEmail=ownerEmail(env);await rateLimit(request,env,'signup-ip',8);
  const data=await body(request),address=email(data.email),secret=password(data.password);
  await rateLimit(request,env,'signup-email',5,address);
  if(address===adminEmail)fail(403,'관리자 이메일은 기존 관리자 비밀번호로 로그인해 주세요.','owner_signup_forbidden');
  const id=crypto.randomUUID().replaceAll('-',''),{hash}=await passwordOperation<{hash:string}>(env,'/hash',{password:secret}),version=crypto.randomUUID(),now=Date.now();
  const result=await env.DB.batch([
    env.DB.prepare("INSERT INTO members(id,email,role,status,workspace_slug,namespace,password_hash,credential_version,created_at) VALUES(?,?,'member','pending',?,?,?,?,?) ON CONFLICT(email) DO NOTHING").bind(id,address,id,`m_${id}`,hash,version,now),
    env.DB.prepare('INSERT INTO member_notice_outbox(member_id,email) SELECT id,email FROM members WHERE id=? ON CONFLICT(member_id) DO NOTHING').bind(id)
  ]);
  if(!result[0].meta.changes)fail(409,'이미 가입 신청한 이메일입니다. 로그인해 주세요.','email_registered');
  const notice=retryPendingNotices(env,id).catch(()=>{});if(ctx)ctx.waitUntil(notice);else await notice;
  const row=await env.DB.prepare('SELECT * FROM members WHERE id=?').bind(id).first<MemberRow>()??fail(409,'다시 로그인해 주세요.');
  const session=await createSession(request,env,row,version);
  return sessionJson(session.member,201,session.headers);
}
async function login(request:Request,env:Env) {
  const adminEmail=ownerEmail(env);await rateLimit(request,env,'login-ip',12);
  const data=await body(request),address=email(data.email),secret=password(data.password);
  await rateLimit(request,env,'login-email',8,address);
  let row:MemberRow|null,version:string;
  if(address===adminEmail) {
    const credential=await passwordOperation<{valid:boolean;version:string}>(env,'/verify',{password:secret});
    if(!credential.valid)fail(401,'이메일 또는 비밀번호가 일치하지 않습니다.','invalid_credentials');
    await env.DB.prepare("INSERT INTO members(id,email,role,status,workspace_slug,namespace,password_hash,credential_version,created_at) VALUES('owner',?,'owner','approved','owner',NULL,NULL,NULL,?) ON CONFLICT DO NOTHING").bind(address,Date.now()).run();
    row=await env.DB.prepare("SELECT * FROM members WHERE id='owner' AND email=?").bind(address).first<MemberRow>();
    if(!row)fail(503,'관리자 이메일 설정을 확인해 주세요.','members_unconfigured');
    version=credential.version;
  } else {
    row=await env.DB.prepare("SELECT * FROM members WHERE email=? AND role='member'").bind(address).first<MemberRow>();
    if(!row?.password_hash || !(await passwordOperation<{valid:boolean}>(env,'/matches',{password:secret,hash:row.password_hash})).valid)fail(401,'이메일 또는 비밀번호가 일치하지 않습니다.','invalid_credentials');
    version=row.credential_version!;
  }
  const session=await createSession(request,env,row,version);return sessionJson(session.member,200,session.headers);
}
async function changePassword(request:Request,env:Env,member:MemberSession) {
  await rateLimit(request,env,'password-ip',8);await rateLimit(request,env,'password-account',8,member.id);
  const data=await body(request),current=password(data.currentPassword),next=password(data.newPassword);
  if(member.role==='owner') {
    const stub=env.PASSWORD_VERIFIER.get(env.PASSWORD_VERIFIER.idFromName('admin-password'));
    const response=await stub.fetch('https://password.internal/member-change',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:current,newPassword:next,sessionHash:member.tokenHash})});
    if(response.status===403)fail(403,'현재 비밀번호가 일치하지 않습니다.','invalid_current_password');
    if(response.status===409)fail(409,'비밀번호 또는 세션이 변경되었습니다. 다시 로그인해 주세요.','credential_changed');
    if(!response.ok)fail(503,'관리자 비밀번호 설정을 확인해 주세요.','admin_unconfigured');
  } else {
    const row=await env.DB.prepare('SELECT password_hash FROM members WHERE id=? AND credential_version=?').bind(member.id,member.credentialVersion).first<{password_hash:string}>();
    if(!row || !(await passwordOperation<{valid:boolean}>(env,'/matches',{password:current,hash:row.password_hash})).valid)fail(403,'현재 비밀번호가 일치하지 않습니다.','invalid_current_password');
    const {hash}=await passwordOperation<{hash:string}>(env,'/hash',{password:next});
    const changed=await env.DB.prepare('UPDATE members SET password_hash=?,credential_version=? WHERE id=? AND credential_version=? AND EXISTS(SELECT 1 FROM member_sessions WHERE token_hash=? AND member_id=members.id AND credential_version=members.credential_version AND expires_at>?)').bind(hash,crypto.randomUUID(),member.id,member.credentialVersion,member.tokenHash,Date.now()).run();
    if(!changed.meta.changes)fail(409,'비밀번호 또는 세션이 변경되었습니다. 다시 로그인해 주세요.','credential_changed');
  }
  await revokeWorkspaceAdmins(env,workspace(member));
  const headers=new Headers({'Set-Cookie':sessionCookie('',0)});headers.append('Set-Cookie',await revokeWorkspaceAdmin(request,env,workspace(member)));
  return new Response(JSON.stringify({ok:true}),{headers:new Headers([...headers,['Content-Type','application/json'],['Cache-Control','no-store']])});
}
async function review(request:Request,env:Env,owner:MemberSession,id:string,decision:'approved'|'rejected') {
  await body(request);
  if(!/^[a-f0-9]{32}$/.test(id))fail(404,'가입 신청을 찾을 수 없습니다.','not_found');
  const changed=await env.DB.prepare(`UPDATE members SET status=?,reviewed_at=? WHERE id=? AND role='member' AND status='pending' AND EXISTS(SELECT 1 FROM member_sessions s JOIN members o ON o.id=s.member_id JOIN admin_credentials a ON a.id=1 WHERE s.token_hash=? AND o.id='owner' AND o.role='owner' AND o.status='approved' AND o.email=? AND s.expires_at>? AND s.credential_version=a.version) RETURNING workspace_slug,namespace`).bind(decision,Date.now(),id,owner.tokenHash,ownerEmail(env),Date.now()).first<{workspace_slug:string;namespace:string}>();
  if(!changed)fail(409,'이미 처리되었거나 세션이 변경되었습니다. 화면을 새로 고쳐 주세요.','request_changed');
  if(decision==='approved')await ensureWorkspace(env,{slug:changed.workspace_slug,namespace:changed.namespace});
  return json({ok:true});
}
export async function handleMemberRequest(request:Request,env:Env,ctx?:ExecutionContext):Promise<Response|null> {
  const path=new URL(request.url).pathname,method=request.method;
  if(!path.startsWith('/api/members/'))return null;
  try {
    if(method!=='GET')sameOrigin(request);
    if(path==='/api/members/signup' && method==='POST')return await signup(request,env,ctx);
    if(path==='/api/members/login' && method==='POST')return await login(request,env);
    if(path==='/api/members/password-reset/request' && method==='POST') {
      ownerEmail(env);await rateLimit(request,env,'reset-request-ip',10);
      const data=await body(request),address=email(data.email);
      await rateLimit(request,env,'reset-request-email',3,address);
      await requestPasswordReset(env,address);
      return json({ok:true});
    }
    if(path==='/api/members/password-reset/confirm' && method==='POST') {
      ownerEmail(env);await rateLimit(request,env,'reset-confirm-ip',12);
      const data=await body(request),next=password(data.newPassword);
      const target=await confirmPasswordReset(env,data.token,next);
      await revokeWorkspaceAdmins(env,{slug:target.workspaceSlug,namespace:target.namespace});
      return json({ok:true});
    }
    if(path==='/api/members/session' && method==='GET') {
      const member=await getMemberSession(request,env),headers=new Headers();
      if(member?.status==='approved')headers.append('Set-Cookie',await memberAdminSession(request,env,workspace(member)));
      return sessionJson(member,200,headers);
    }
    const member=await requireSession(request,env);
    if(method!=='GET')requireCsrf(request,member);
    if(path==='/api/members/polls')return await memberPolls(request,env,member,()=>body(request));
    const pollDelete=/^\/api\/members\/polls\/([a-z0-9][a-z0-9-]{1,47})$/.exec(path);
    if(pollDelete && method==='DELETE')return await deleteMemberPoll(env,member,pollDelete[1],await body(request));
    if(path==='/api/members/session' && method==='DELETE') {
      await env.DB.prepare('DELETE FROM member_sessions WHERE token_hash=?').bind(member.tokenHash).run();
      const headers=new Headers({'Set-Cookie':sessionCookie('',0)});headers.append('Set-Cookie',await revokeWorkspaceAdmin(request,env,workspace(member)));
      return new Response(JSON.stringify({ok:true}),{headers:new Headers([...headers,['Content-Type','application/json'],['Cache-Control','no-store']])});
    }
    if(path==='/api/members/password' && method==='POST')return await changePassword(request,env,member);
    if(member.role!=='owner' || member.status!=='approved')fail(403,'가입 승인에는 관리자 권한이 필요합니다.','forbidden');
    if(path==='/api/members/requests' && method==='GET') {
      const result=await env.DB.prepare("SELECT id,email,status,created_at,reviewed_at FROM members WHERE role='member' ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC LIMIT 500").all<Pick<MemberRow,'id'|'email'|'status'|'created_at'|'reviewed_at'>>();
      return json({requests:result.results.map(row=>({id:row.id,email:row.email,status:row.status,createdAt:new Date(row.created_at).toISOString(),reviewedAt:row.reviewed_at===null?null:new Date(row.reviewed_at).toISOString()}))});
    }
    const match=/^\/api\/members\/requests\/([^/]+)\/(approve|reject)$/.exec(path);
    if(match && method==='POST')return await review(request,env,member,match[1],match[2]==='approve'?'approved':'rejected');
    return json({error:'요청을 찾을 수 없습니다.',code:'not_found'},404);
  } catch(error) {
    if(error instanceof MemberError || error instanceof PasswordResetError)return json({error:error.message,code:error.code},error.status);
    throw error;
  }
}
