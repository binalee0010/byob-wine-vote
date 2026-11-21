import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { client, createApp, TEST_PASSWORD } from './harness.mjs';

const SUPERADMIN_EMAIL='superadmin@example.test', MEMBER_PASSWORD='8';
function memberClient(mf,ip) {
  const request=client(mf);let csrf;
  return async (path,method='GET',data,options={})=>{
    const headers={...(csrf?{'X-Member-CSRF':csrf}:{}),'CF-Connecting-IP':ip,...options.headers};
    const response=await request(path,method,data,{...options,headers});
    if(response.body && 'csrfToken' in response.body)csrf=response.body.csrfToken;
    return response;
  };
}
async function ownerLogin(api,password=TEST_PASSWORD) {
  const response=await api('/api/members/login','POST',{email:SUPERADMIN_EMAIL,password});assert.equal(response.status,200);return response;
}
async function signup(api,email='member@example.test',password=MEMBER_PASSWORD) {
  const response=await api('/api/members/signup','POST',{email,password});assert.equal(response.status,201);return response;
}

test('configured owner requires the existing password; signup remains pending and queues a durable notice',async()=>{
  const local=await createApp({bindings:{SUPERADMIN_EMAIL}});
  try {
    const owner=memberClient(local.mf,'192.0.2.1'),member=memberClient(local.mf,'192.0.2.2');
    const legacy=await local.db.prepare('SELECT * FROM event').first();
    assert.equal((await owner('/v/owner/api/bootstrap')).status,404);
    assert.equal((await owner('/api/members/signup','POST',{email:SUPERADMIN_EMAIL.toUpperCase(),password:MEMBER_PASSWORD})).body.code,'owner_signup_forbidden');
    assert.equal((await owner('/api/members/login','POST',{email:SUPERADMIN_EMAIL,password:MEMBER_PASSWORD})).status,401);
    assert.equal(await local.db.prepare("SELECT id FROM members WHERE role='owner'").first(),null);
    const signed=await signup(member,' Member@Example.Test ');
    assert.equal(signed.body.member.email,'member@example.test');assert.equal(signed.body.member.status,'pending');
    assert.match(signed.body.member.workspaceSlug,/^[a-f0-9]{32}$/);
    assert.match(signed.headers.getSetCookie().find(v=>v.startsWith('__Host-byob_member=')),/HttpOnly; Secure; SameSite=Strict/);
    const row=await local.db.prepare('SELECT * FROM members WHERE id=?').bind(signed.body.member.id).first();
    assert.match(row.password_hash,/^scrypt\$16384\$16\$1\$/);assert.notEqual(row.password_hash,MEMBER_PASSWORD);
    assert.equal(await local.db.prepare("SELECT name FROM sqlite_master WHERE name=?").bind(`${row.namespace}_event`).first(),null);
    assert.equal((await member('/api/admin/state')).status,401);
    assert.equal((await member('/api/members/requests')).status,403);
    assert.equal((await member('/api/members/signup','POST',{email:row.email,password:'Different-password!'})).status,409);
    const outbox=await local.db.prepare('SELECT * FROM member_notice_outbox WHERE member_id=?').bind(row.id).first();
    assert.equal(outbox.email,row.email);assert.equal(outbox.sent_at,null);assert(outbox.attempts>=1);assert.equal(outbox.last_error,'delivery_failed');
    const authenticated=await ownerLogin(owner);assert.equal(authenticated.body.member.role,'owner');
    const requests=await owner('/api/members/requests');assert.equal(requests.body.requests.length,1);assert.equal(requests.body.requests[0].status,'pending');
    assert(!JSON.stringify(requests.body).includes('password_hash'));assert(!JSON.stringify(requests.body).includes(row.password_hash));
    assert.deepEqual(await local.db.prepare('SELECT * FROM event').first(),legacy);
    assert.equal((await owner('/api/members/requests/'+row.id+'/approve','POST',{}, {headers:{'X-Member-CSRF':''}})).status,403);
    assert.equal((await member('/api/members/session','DELETE',undefined,{headers:{Origin:'https://other.test'}})).status,403);
    assert.equal((await member('/api/members/session')).body.member.status,'pending');
  } finally {await local.mf.dispose();}
});

test('approval is conditional, personal passwords revoke all own sessions, and owner reset preserves members',async()=>{
  const local=await createApp({bindings:{SUPERADMIN_EMAIL}});
  try {
    const owner=memberClient(local.mf,'192.0.2.10'),ownerTwo=memberClient(local.mf,'192.0.2.11');
    const member=memberClient(local.mf,'192.0.2.12'),memberTwo=memberClient(local.mf,'192.0.2.13'),rejected=memberClient(local.mf,'192.0.2.14');
    await ownerLogin(owner);await ownerLogin(ownerTwo);
    const signed=await signup(member),id=signed.body.member.id;
    const decisions=await Promise.all([owner(`/api/members/requests/${id}/approve`,'POST',{}),ownerTwo(`/api/members/requests/${id}/reject`,'POST',{})]);
    assert.equal(decisions.filter(v=>v.status===200).length,1);assert.equal(decisions.filter(v=>v.status===409).length,1);
    const decided=await local.db.prepare('SELECT status FROM members WHERE id=?').bind(id).first();
    // Use whichever concurrent decision won, then create a fresh pending member when rejection won.
    let approvedId=id;
    if(decided.status==='rejected') {
      const replacement=await signup(member,'approved@example.test');approvedId=replacement.body.member.id;
      assert.equal((await owner(`/api/members/requests/${approvedId}/approve`,'POST',{})).status,200);
    }
    const approved=await member('/api/members/session');assert.equal(approved.body.member.status,'approved');
    const address=approved.body.member.email;
    assert.equal((await member('/api/admin/state')).status,200);
    assert.equal((await memberTwo('/api/members/login','POST',{email:address,password:TEST_PASSWORD})).status,401);
    assert.equal((await memberTwo('/api/members/login','POST',{email:address,password:MEMBER_PASSWORD})).status,200);
    assert.equal((await member('/api/members/password','POST',{currentPassword:'wrong',newPassword:'7412'})).body.code,'invalid_current_password');
    const changed=await member('/api/members/password','POST',{currentPassword:MEMBER_PASSWORD,newPassword:'7412'});assert.equal(changed.status,200);
    assert.equal((await member('/api/members/session')).body.authenticated,false);
    assert.equal((await memberTwo('/api/members/session')).body.authenticated,false);
    assert.equal((await memberTwo('/api/admin/state')).status,401);
    assert.equal((await owner('/api/admin/state')).status,200);
    assert.equal((await member('/api/members/login','POST',{email:address,password:MEMBER_PASSWORD})).status,401);
    assert.equal((await member('/api/members/login','POST',{email:address,password:'7412'})).status,200);
    const denied=await signup(rejected,'rejected@example.test');
    assert.equal((await owner(`/api/members/requests/${denied.body.member.id}/reject`,'POST',{})).status,200);
    assert.equal((await rejected('/api/members/session')).body.authenticated,false);
    assert.equal((await rejected('/api/members/login','POST',{email:'rejected@example.test',password:MEMBER_PASSWORD})).body.member.status,'rejected');
    assert.equal((await rejected('/api/admin/state')).status,401);
    assert.equal((await owner('/api/members/password','POST',{currentPassword:TEST_PASSWORD,newPassword:'Changed-owner-password!'})).status,200);
    assert.equal((await ownerTwo('/api/members/session')).body.authenticated,false);
    assert.equal((await member('/api/admin/state')).status,200);
    assert.equal((await owner('/api/members/login','POST',{email:SUPERADMIN_EMAIL,password:TEST_PASSWORD})).status,401);
    await ownerLogin(owner,'Changed-owner-password!');
    const logout=await member('/api/members/session','DELETE');assert.equal(logout.status,200);
    assert.equal((await member('/api/admin/state')).status,401);
  } finally {await local.mf.dispose();}
});

test('signup races preserve the first hash and rate limits fail closed',async()=>{
  const local=await createApp({bindings:{SUPERADMIN_EMAIL}});
  try {
    const api=memberClient(local.mf,'192.0.2.20');
    const duplicates=await Promise.all([api('/api/members/signup','POST',{email:'race@example.test',password:MEMBER_PASSWORD}),api('/api/members/signup','POST',{email:'RACE@example.test',password:'Alternative-password!'})]);
    assert.deepEqual(duplicates.map(v=>v.status).sort(),[201,409]);
    assert.equal((await local.db.prepare("SELECT count(*) AS n FROM members WHERE email='race@example.test'").first()).n,1);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM member_notice_outbox').first()).n,1);
    const attempt=()=>api('/api/members/login','POST',{email:'unknown@example.test',password:'Incorrect-password!'});
    for(let i=0;i<8;i++)assert.equal((await attempt()).status,401);
    assert.equal((await attempt()).status,429);
    assert.equal((await api('/api/members/login','POST',{email:SUPERADMIN_EMAIL,password:TEST_PASSWORD},{headers:{Origin:''}})).status,403);
  } finally {await local.mf.dispose();}
  const unconfigured=await createApp({bindings:{MEMBERSHIP_REQUIRED:'true'}});
  try {
    const api=client(unconfigured.mf);
    assert.equal((await api('/api/members/login','POST',{email:SUPERADMIN_EMAIL,password:TEST_PASSWORD})).status,503);
    assert.equal((await api('/api/admin/login','POST',{password:TEST_PASSWORD})).status,503);
  }
  finally {await unconfigured.mf.dispose();}
});

test('both additive membership migrations preserve legacy rows and enforce owner identity',async()=>{
  const migration=await readFile(new URL('../migrations/0002_members.sql',import.meta.url),'utf8');
  assert.equal(await readFile(new URL('../migrations-existing/0013_members.sql',import.meta.url),'utf8'),migration);
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
    db.exec("INSERT INTO participants(id,name,name_key) VALUES('legacy','Legacy participant','legacy');INSERT INTO vote_history(id,revision,saved_at,snapshot) VALUES('old',0,'2026-01-01','{}')");
    const before=db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    db.exec(migration);
    for(const row of before)assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(row.name).sql,row.sql);
    assert.equal(db.prepare('SELECT name FROM participants').get().name,'Legacy participant');
    assert.equal(db.prepare('SELECT snapshot FROM vote_history').get().snapshot,'{}');
    assert.throws(()=>db.exec("INSERT INTO members(id,email,role,status,workspace_slug,created_at) VALUES('pretend','evil@example.test','owner','approved','owner',0)"),/CHECK/);
    assert.throws(()=>db.exec("INSERT INTO member_sessions(token_hash,member_id,credential_version,csrf_token,expires_at) VALUES('fake','owner','fake','fake',1)"),/member_credential_changed/);
  } finally {db.close();}
});
