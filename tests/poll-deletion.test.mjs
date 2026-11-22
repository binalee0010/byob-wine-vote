import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {client,createApp,photo,PNG,TEST_PASSWORD} from './harness.mjs';

const bindings={SUPERADMIN_EMAIL:'owner@example.test'},password='8';
function memberClient(mf){const api=client(mf);let csrf='';return async(path,method='GET',data,options={})=>{const response=await api(path,method,data,{...options,headers:{'x-member-csrf':csrf,...options.headers}});if(response.body?.csrfToken)csrf=response.body.csrfToken;return response;};}
async function login(owner){const response=await owner('/api/members/login','POST',{email:bindings.SUPERADMIN_EMAIL,password:TEST_PASSWORD});assert.equal(response.status,200,JSON.stringify(response.body));return response;}
async function approve(owner,api,email){const response=await api('/api/members/signup','POST',{email,password});assert.equal(response.status,201);assert.equal((await owner(`/api/members/requests/${response.body.member.id}/approve`,'POST',{})).status,200);await api('/api/members/session');return response.body.member;}
const path=slug=>`/v/${slug}/api`;
async function create(api,title,requestId){const response=await api('/api/members/polls','POST',{title,requestId});assert.equal(response.status,201,JSON.stringify(response.body));return response.body.poll;}
async function state(api,slug){const response=await api(`${path(slug)}/admin/state`);assert.equal(response.status,200,JSON.stringify(response.body));return response.body;}
const remove=(api,slug,options)=>api(`/api/members/polls/${slug}`,'DELETE',{confirm:'delete-poll'},options);
async function modules(){const result=await build({entryPoints:['worker/index.ts','worker/poll-deletion.ts','worker/workspaces.ts'],bundle:true,write:false,outdir:'unused',format:'esm',platform:'node',external:['node:*'],loader:{'.sql':'text'}});return Promise.all(result.outputFiles.map(async file=>import(`data:text/javascript;base64,${Buffer.from(file.text).toString('base64')}`)));}
async function authCookie(api,email){const response=await api('/api/members/login','POST',{email,password});assert.equal(response.status,200);return {cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),csrf:response.body.csrfToken};}
function request(slug,auth){return new Request(`https://vote.test/api/members/polls/${slug}`,{method:'DELETE',headers:{Origin:'https://vote.test',Cookie:auth.cookie,'Content-Type':'application/json','x-member-csrf':auth.csrf},body:JSON.stringify({confirm:'delete-poll'})});}

test('confirmed owner permanently deletes exactly one namespace, ballots, live/archive photos and stale URLs',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf),a=memberClient(local.mf),b=memberClient(local.mf),anon=client(local.mf),person=client(local.mf);
    await login(owner);const account=await approve(owner,a,'delete-a@example.test');await approve(owner,b,'delete-b@example.test');
    const first=await create(a,'Delete exactly this','delete-first'),second=await create(a,'Keep same owner','keep-second'),third=await create(b,'Keep other owner','keep-third');
    const upload=await a(`${path(first.slug)}/admin/candidates`,'POST',photo('Sensitive wine'));assert.equal(upload.status,200);const candidate=upload.body.candidate;
    assert.equal((await a(`${path(first.slug)}/admin/activities/byob/state`,'POST',{action:'open',revision:0})).status,200);
    assert.equal((await person(`${path(first.slug)}/session`,'POST',{name:'Sensitive person'})).status,200);
    assert.equal((await person(`${path(first.slug)}/activities/byob/answer`,'PUT',{ranking:[candidate.id],revision:0})).status,200);
    assert.equal((await a(`${path(first.slug)}/admin/activities/byob/state`,'POST',{action:'close',revision:0})).status,200);
    const current=await state(a,first.slug);
    const publicPath=new URL(current.participantUrl).pathname,publicSlug=publicPath.split('/').at(-1);
    assert.match(publicSlug,/^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
    assert.equal((await person(publicPath+'/api/bootstrap')).body.participant.submitted.byob,true);
    await local.db.prepare(`INSERT INTO m_${first.slug}_vote_history VALUES('old-archive',0,'today','{}')`).run();
    const bucket=await local.mf.getR2Bucket('PHOTOS');
    const prefix=`members/m_${first.slug}/`;
    await bucket.put(prefix+'orphan/late-photo',PNG);await bucket.put('candidates/legacy-unrelated',PNG);await bucket.put(`members/m_${third.slug}/unrelated`,PNG);
    await local.db.prepare(`INSERT INTO m_${first.slug}_candidate_photo_cleanup VALUES(?)`).bind(`members/m_${third.slug}/unrelated`).run();
    const beforeSecond=await state(a,second.slug),beforeThird=await state(b,third.slug);
    const credentials=await local.db.prepare('SELECT * FROM members WHERE id=?').bind(account.id).first();
    assert.equal((await remove(anon,first.slug)).status,401);
    const unknown=await remove(b,'a'.repeat(32)),forbidden=await remove(b,first.slug);assert.equal(forbidden.status,404);assert.deepEqual(forbidden.body,unknown.body);
    assert.equal((await remove(owner,first.slug)).status,404);
    assert.equal((await remove(a,first.slug,{headers:{'x-member-csrf':''}})).status,403);
    assert.equal((await remove(a,first.slug,{headers:{Origin:'https://evil.test'}})).status,403);
    assert.equal((await a(`/api/members/polls/${first.slug}`,'DELETE',{confirm:'delete'})).status,400);
    assert.deepEqual((await remove(a,first.slug)).body,{ok:true,slug:first.slug});
    const names=(await local.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?").bind(`m_${first.slug}_%`).all()).results;
    assert(names.length>=12);
    for(const {name}of names)assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM ${name}`).first()).n,0,name);
    assert.equal((await bucket.list({prefix})).objects.length,0);
    assert(await bucket.get('candidates/legacy-unrelated'));assert(await bucket.get(`members/m_${third.slug}/unrelated`));
    for(const url of [`/v/${first.slug}`,`${path(first.slug)}/bootstrap`,candidate.photoUrl,`${path(first.slug)}/admin/history/old-archive`,`${path(first.slug)}/admin/state`,publicPath,publicPath+'/api/bootstrap',publicPath+'/api/photos/'+candidate.id])assert.equal((await a(url)).status,404,url);
    assert.equal((await person(`${path(first.slug)}/session`,'POST',{name:'Must not return'})).status,404);
    assert.equal((await person(`${path(first.slug)}/activities/byob/answer`,'PUT',{ranking:[candidate.id],revision:0})).status,404);
    assert.equal((await person(publicPath+'/api/session','POST',{name:'Must not return'})).status,404);
    assert.equal((await person(publicPath+'/api/activities/byob/answer','PUT',{ranking:[candidate.id],revision:0})).status,404);
    assert.deepEqual(await state(a,second.slug),beforeSecond);assert.deepEqual(await state(b,third.slug),beforeThird);
    assert.deepEqual(await local.db.prepare('SELECT * FROM members WHERE id=?').bind(account.id).first(),credentials);
    assert.equal((await a('/api/members/session')).body.authenticated,true);
    assert.deepEqual((await a('/api/members/polls')).body.polls,[second]);
    assert.deepEqual((await remove(a,first.slug)).body,{ok:true,slug:first.slug});
    assert.equal((await a('/api/members/polls','POST',{title:first.title,requestId:'delete-first'})).status,410);
    assert.equal((await a('/api/members/polls')).body.polls.length,1);
    assert.deepEqual(await local.db.prepare('SELECT poll_slug,alias FROM poll_public_links WHERE alias=?').bind(publicSlug).first(),{poll_slug:first.slug,alias:publicSlug});
    await assert.rejects(local.db.prepare(`INSERT INTO m_${first.slug}_participants VALUES('late','Late','late')`).run(),/poll_deleted/);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await local.mf.dispose();}
});

test('deleting old member default alias prevents lazy registration and preserves login and newer polls',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf),api=memberClient(local.mf);await login(owner);const account=await approve(owner,api,'default-delete@example.test');
    await local.db.prepare(`UPDATE m_${account.id}_event SET title='Old default poll'`).run();
    assert.equal((await api('/api/members/polls')).body.polls[0].slug,account.workspaceSlug);
    assert.equal((await remove(api,account.workspaceSlug)).status,200);
    for(let index=0;index<2;index++)assert.deepEqual((await api('/api/members/polls')).body,{polls:[]});
    assert.equal((await api('/api/members/session')).body.authenticated,true);
    assert.equal((await api('/api/members/login','POST',{email:account.email,password})).status,200);
    assert.equal((await api('/api/admin/state')).status,404);assert.equal((await api(`${path(account.workspaceSlug)}/bootstrap`)).status,404);
    const next=await create(api,'Still usable account','after-default-delete');assert.equal((await state(api,next.slug)).event.title,next.title);
    assert.equal((await remove(api,next.slug)).status,200);
    assert.deepEqual((await api('/api/members/polls')).body,{polls:[]});
    const interrupted=crypto.randomUUID().replaceAll('-','');
    await local.db.prepare('INSERT INTO member_polls(slug,member_id,namespace,request_id,creation_title,created_at) VALUES(?,?,?,?,?,?)').bind(interrupted,account.id,`m_${interrupted}`,'interrupted-deletion','Interrupted create',Date.now()).run();
    assert.equal((await remove(api,interrupted)).status,200);
    assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM m_${interrupted}_event`).first()).n,0);
    const [, ,workspaces]=await modules();await workspaces.ensureWorkspace({DB:local.db},{slug:interrupted,namespace:`m_${interrupted}`});
    assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM m_${interrupted}_event`).first()).n,0);
    assert.equal((await api('/api/members/polls','POST',{title:'Interrupted create',requestId:'interrupted-deletion'})).status,410);
  }finally{await local.mf.dispose();}
});

test('legacy owner deletion fences root aliases while retaining shared SQL, grades, archives, credentials and photos',async()=>{
  const local=await createApp({legacy:true,bindings});
  try{
    for(const file of ['0002_members.sql','0003_password_reset.sql']){
      const sql=await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8');
      for(const statement of sql.split(/;\s*(?:\r?\n|$)/).map(value=>value.trim()).filter(Boolean))await local.db.prepare(statement).run();
    }
    const owner=memberClient(local.mf),person=client(local.mf);const authenticated=await login(owner),slug=authenticated.body.member.workspaceSlug,base=`/v/${slug}/api`;
    const joined=await person(base+'/session','POST',{name:'Shared legacy participant'});assert.equal(joined.status,200);
    await local.db.prepare("UPDATE activities SET status='open',started_at='legacy' WHERE id='price'").run();
    await local.db.prepare("INSERT INTO answers VALUES('price',?,'{\"price\":5}','legacy')").bind(joined.body.participant.id).run();
    await local.db.prepare("INSERT INTO grades VALUES(?,'private result','private note','{}')").bind(joined.body.participant.id).run();
    const upload=await owner('/api/admin/candidates','POST',photo('Legacy shared photo'));assert.equal(upload.status,200);
    const bucket=await local.mf.getR2Bucket('PHOTOS');
    await bucket.put('archives/untyped-other-app',PNG);
    assert.equal((await owner('/api/members/polls')).body.polls[0].slug,slug);
    const tables=['event','activities','participants','sessions','answers','grades','candidates','vote_history','admin_credentials','admin_bootstrap_history'];
    const dump=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
    const before=await dump(),photos=(await bucket.list()).objects.map(row=>row.key);
    const [worker]=await modules();let deleted=false;
    const DB={prepare:sql=>local.db.prepare(sql),async batch(statements){deleted=true;assert.deepEqual((await remove(owner,slug)).body,{ok:true,slug});return local.db.batch(statements);}};
    const staleLogin=await worker.default.fetch(new Request(`https://vote.test${base}/session`,{method:'POST',headers:{Origin:'https://vote.test','Content-Type':'application/json'},body:JSON.stringify({name:'Late shared participant'})}),{...bindings,DB,PHOTOS:bucket});
    assert(deleted);assert.equal(staleLogin.status,404);
    assert.deepEqual(await dump(),before);assert.deepEqual((await bucket.list()).objects.map(row=>row.key),photos);
    for(const url of ['/api/bootstrap','/api/activities/byob','/api/results/byob','/api/admin/state',upload.body.candidate.photoUrl,'/v/owner','/v/owner/api/bootstrap'])assert.equal((await owner(url)).status,404,url);
    assert.equal((await person('/api/session','POST',{name:'No resurrection'})).status,404);
    assert.equal((await owner('/api/members/session')).body.authenticated,true);
    await login(owner);assert.deepEqual((await owner('/api/members/polls')).body,{polls:[]});
    const next=await create(owner,'Owner account survives','owner-after-delete');assert.equal((await remove(owner,next.slug)).status,200);
    assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM m_${next.slug}_event`).first()).n,0);
    assert.deepEqual(await dump(),before);
  }finally{await local.mf.dispose();}
});

test('in-flight participant login, ballot and admin edit cannot repopulate a deleted namespace',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf),api=memberClient(local.mf);await login(owner);const account=await approve(owner,api,'late-write@example.test');const [worker]=await modules();
    const auth=await authCookie(api,account.email),bucket=await local.mf.getR2Bucket('PHOTOS');
    for(const action of ['login','vote','edit']){
      const poll=await create(api,`Late ${action}`,`late-write-${action}`);let candidate,cookie='';
      if(action==='vote'){
        candidate=(await api(`${path(poll.slug)}/admin/candidates`,'POST',{name:'Voting wine',requestId:'late-vote-wine',revision:0})).body.candidate;
        await api(`${path(poll.slug)}/admin/activities/byob/state`,'POST',{action:'open',revision:0});
        const participant=await client(local.mf)(`${path(poll.slug)}/session`,'POST',{name:'Late voter'});
        cookie=participant.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
      }
      let deleted=false;const marked=new WeakSet();
      const inject=async()=>{assert.equal((await remove(api,poll.slug)).status,200);deleted=true;};
      const DB={async batch(statements){if(action==='login' && statements.some(statement=>marked.has(statement)))await inject();return local.db.batch(statements);},prepare(sql){
        const statement=local.db.prepare(sql);
        if(action==='login' && sql.startsWith(`INSERT INTO m_${poll.slug}_participants`))return {bind(...args){const bound=statement.bind(...args);marked.add(bound);return bound;}};
        if((action==='vote' && sql.startsWith(`INSERT INTO m_${poll.slug}_answers`)) || (action==='edit' && sql.startsWith(`UPDATE m_${poll.slug}_event SET`)))return {bind(...args){return {async run(){await inject();return statement.bind(...args).run();}};}};
        return statement;
      }};
      const suffix=action==='login'?'/session':action==='vote'?'/activities/byob/answer':'/admin/event';
      const data=action==='login'?{name:'Late login'}:action==='vote'?{ranking:[candidate.id],revision:0}:{title:'Late edit',startsAt:'2026-11-22T12:00:00+09:00',timezone:'Asia/Seoul'};
      const response=await worker.default.fetch(new Request(`https://vote.test${path(poll.slug)}${suffix}`,{method:action==='edit'?'PATCH':action==='vote'?'PUT':'POST',headers:{Origin:'https://vote.test','Content-Type':'application/json',Cookie:action==='edit'?auth.cookie:cookie,'x-member-csrf':auth.csrf},body:JSON.stringify(data)}),{...bindings,DB,PHOTOS:bucket});
      assert(deleted,`${action}: ${response.status} ${await response.clone().text()}`);assert.equal(response.status,404,action);
      for(const table of ['event','participants','sessions','answers','candidates','candidate_photo_cleanup'])assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM m_${poll.slug}_${table}`).first()).n,0,`${action}: ${table}`);
    }
  }finally{await local.mf.dispose();}
});

test('overlapping empty sweeps cannot clear a newer late-upload cleanup generation',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf),api=memberClient(local.mf);await login(owner);await approve(owner,api,'overlap-photos@example.test');const poll=await create(api,'Overlap','cleanup-overlap');
    const [,deletion,workspaces]=await modules(),bucket=await local.mf.getR2Bucket('PHOTOS');let releasePut,putStarted,releaseEmpty,emptyReached;
    const heldPut=new Promise(resolve=>{releasePut=resolve;}),started=new Promise(resolve=>{putStarted=resolve;}),heldEmpty=new Promise(resolve=>{releaseEmpty=resolve;}),empty=new Promise(resolve=>{emptyReached=resolve;});
    let heldLists=0;
    const late={async put(...args){putStarted();await heldPut;return bucket.put(...args);},delete(){throw new Error('Late R2 delete failed');}};
    const env={...bindings,DB:local.db,PHOTOS:late};const scoped=workspaces.workspaceEnv(env,{slug:poll.slug,namespace:`m_${poll.slug}`});
    const key=`members/m_${poll.slug}/candidates/inflight-overlap`;const upload=scoped.PHOTOS.put(key,PNG);await started;
    await remove(api,poll.slug);await local.db.prepare('UPDATE member_polls SET cleanup_pending=1,cleanup_version=cleanup_version+1 WHERE slug=?').bind(poll.slug).run();
    const firstPhotos={async list(options){const page=await bucket.list(options);if(++heldLists===2){emptyReached();await heldEmpty;}return page;},delete:keys=>bucket.delete(keys)};
    const first=deletion.retryDeletedPollPhotos({...bindings,DB:local.db,PHOTOS:firstPhotos});await empty;
    await deletion.retryDeletedPollPhotos({...bindings,DB:local.db,PHOTOS:bucket});assert.equal((await local.db.prepare('SELECT cleanup_pending FROM member_polls WHERE slug=?').bind(poll.slug).first()).cleanup_pending,0);
    releasePut();await assert.rejects(upload,/Late R2 delete failed/);assert(await bucket.get(key));
    releaseEmpty();await first;assert.equal((await local.db.prepare('SELECT cleanup_pending FROM member_polls WHERE slug=?').bind(poll.slug).first()).cleanup_pending,1);
    await deletion.retryDeletedPollPhotos({...bindings,DB:local.db,PHOTOS:bucket});assert.equal(await bucket.get(key),null);assert.equal((await local.db.prepare('SELECT cleanup_pending FROM member_polls WHERE slug=?').bind(poll.slug).first()).cleanup_pending,0);
  }finally{await local.mf.dispose();}
});

test('revoking membership immediately before DELETE batch prevents tombstone and SQL/photo purge',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf),api=memberClient(local.mf);await login(owner);const account=await approve(owner,api,'delete-race@example.test');const poll=await create(api,'Keep after revocation','delete-race');
    const auth=await authCookie(api,account.email),[worker]=await modules();let revoked=false;
    const DB={prepare:sql=>local.db.prepare(sql),async batch(statements){revoked=true;await local.db.prepare('DELETE FROM member_sessions WHERE member_id=?').bind(account.id).run();return local.db.batch(statements);}};
    const response=await worker.default.fetch(request(poll.slug,auth),{...bindings,DB,PHOTOS:await local.mf.getR2Bucket('PHOTOS')});
    assert(revoked);assert.equal(response.status,401);assert.equal((await local.db.prepare('SELECT deleted_at FROM member_polls WHERE slug=?').bind(poll.slug).first()).deleted_at,null);
    assert.equal((await local.db.prepare(`SELECT title FROM m_${poll.slug}_event`).first()).title,poll.title);
  }finally{await local.mf.dispose();}
});

test('failed photo cleanup retries once, finishes durably, and late upload failures rearm pending cleanup',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf),api=memberClient(local.mf);await login(owner);const account=await approve(owner,api,'photos-delete@example.test');const poll=await create(api,'Photos','delete-photos');
    const auth=await authCookie(api,account.email),[worker,deletion,workspaces]=await modules();const bucket=await local.mf.getR2Bucket('PHOTOS');const key=`members/m_${poll.slug}/archives/preserved-until-retry`;await bucket.put(key,PNG);
    let fail=true,lists=0;
    const PHOTOS={list:options=>{lists++;return bucket.list(options);},delete:keys=>{if(fail)throw new Error('Synthetic R2 failure');return bucket.delete(keys);},put:(...args)=>bucket.put(...args)};
    const env={...bindings,DB:local.db,PHOTOS};
    assert.equal((await worker.default.fetch(request(poll.slug,auth),env)).status,200);assert(await bucket.get(key));
    assert((await local.db.prepare('SELECT cleanup_pending FROM member_polls WHERE slug=?').bind(poll.slug).first()).cleanup_pending>0);
    fail=false;await deletion.retryDeletedPollPhotos(env);assert.equal(await bucket.get(key),null);
    assert.equal((await local.db.prepare('SELECT cleanup_pending FROM member_polls WHERE slug=?').bind(poll.slug).first()).cleanup_pending,0);
    const completedLists=lists;await deletion.retryDeletedPollPhotos(env);assert.equal(lists,completedLists);
    assert.equal((await worker.default.fetch(request(poll.slug,auth),env)).status,200);assert.equal(lists,completedLists);
    const next=await create(api,'Late put','delete-late-put');
    let releasePut,started;const pending=new Promise(resolve=>{releasePut=resolve;});const putStarted=new Promise(resolve=>{started=resolve;});let rejectCleanup=false;
    const latePhotos={list:options=>bucket.list(options),async put(key,value,options){started();await pending;return bucket.put(key,value,options);},delete:keys=>{if(rejectCleanup)throw new Error('Late cleanup failure');return bucket.delete(keys);}};
    const lateEnv={...bindings,DB:local.db,PHOTOS:latePhotos};
    const scoped=workspaces.workspaceEnv(lateEnv,{slug:next.slug,namespace:`m_${next.slug}`});const lateKey=`members/m_${next.slug}/candidates/inflight`;
    const upload=scoped.PHOTOS.put(lateKey,PNG);await putStarted;
    assert.equal((await remove(api,next.slug)).status,200);assert.equal((await local.db.prepare('SELECT cleanup_pending FROM member_polls WHERE slug=?').bind(next.slug).first()).cleanup_pending,0);
    rejectCleanup=true;releasePut();await assert.rejects(upload,/Late cleanup failure/);assert(await bucket.get(lateKey));
    assert((await local.db.prepare('SELECT cleanup_pending FROM member_polls WHERE slug=?').bind(next.slug).first()).cleanup_pending>0);
    await deletion.retryDeletedPollPhotos({...bindings,DB:local.db,PHOTOS:bucket});assert.equal(await bucket.get(lateKey),null);
    assert.equal((await local.db.prepare('SELECT cleanup_pending FROM member_polls WHERE slug=?').bind(next.slug).first()).cleanup_pending,0);
  }finally{await local.mf.dispose();}
});
