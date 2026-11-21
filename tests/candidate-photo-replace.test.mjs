import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { client, createApp, photo, PNG, TEST_PASSWORD } from './harness.mjs';

const replacement=(candidate,revision=0,requestId=crypto.randomUUID())=>{const form=photo('Ignored name',requestId);form.set('revision',String(revision));form.set('expectedPhotoUrl',candidate.photoUrl??'');return form;};
const path=candidate=>`/api/admin/candidates/${candidate.id}/photo`;
async function setup(options){const local=await createApp(options),admin=client(local.mf);const auth=await admin('/api/admin/login','POST',{password:TEST_PASSWORD});assert.equal(auth.status,200);return {...local,admin,auth};}
const rows=async db=>(await db.prepare('SELECT * FROM candidates ORDER BY number').all()).results;
const withoutPhoto=c=>{const {object_key,content_type,...rest}=c;return rest;};

test('photo-only changes work before, during and after voting and retain candidate identities, names, ballots and scores',async()=>{
  const local=await setup();
  try{
    const {admin,db}=local,person=client(local.mf),bucket=await local.mf.getR2Bucket('PHOTOS');
    const created=await admin('/api/admin/candidates','POST',{name:'Original wine',description:'Original note',requestId:'original-wine',revision:0});let candidate=created.body.candidate;
    assert.equal(candidate.photoUrl,null);const identity=withoutPhoto((await rows(db))[0]);
    const attached=await admin(path(candidate),'PUT',replacement(candidate));assert.equal(attached.status,200,JSON.stringify(attached.body));candidate=attached.body.candidate;
    assert.match(candidate.photoUrl,/\?v=[a-f0-9]{32}$/);assert(!candidate.photoUrl.includes('/candidates/'));
    assert.equal((await admin('/api/admin/settings','PATCH',{activities:[{id:'byob',revision:0,resultVisibility:'participants'}]})).status,200);
    assert.equal((await admin('/api/admin/activities/byob/state','POST',{action:'open',revision:0})).status,200);
    assert.equal((await person('/api/session','POST',{name:'Preserved voter'})).status,200);
    assert.equal((await person('/api/activities/byob/answer','PUT',{ranking:[candidate.id],revision:0})).status,200);
    const answers=(await db.prepare('SELECT * FROM answers').all()).results;
    for(const state of ['open','closed']){
      if(state==='closed')assert.equal((await admin('/api/admin/activities/byob/state','POST',{action:'close',revision:0})).status,200);
      const oldKey=(await rows(db))[0].object_key,oldUrl=candidate.photoUrl;
      const response=await admin(path(candidate),'PUT',replacement(candidate));assert.equal(response.status,200,JSON.stringify(response.body));candidate=response.body.candidate;
      assert.notEqual(candidate.photoUrl,oldUrl);assert.equal(await bucket.get(oldKey),null);
      assert.deepEqual(withoutPhoto((await rows(db))[0]),identity);assert.deepEqual((await db.prepare('SELECT * FROM answers').all()).results,answers);
      const currentState=(await admin('/api/admin/state')).body;assert.equal(currentState.submittedCount,1);assert.equal(currentState.byobResults[0].points,1);assert.equal(currentState.byobResults[0].photoUrl,candidate.photoUrl);
      assert.equal((await person(candidate.photoUrl)).status,200);
    }
    const current=(await rows(db))[0];assert.deepEqual(Buffer.from(await (await bucket.get(current.object_key)).arrayBuffer()),PNG);assert.equal((await bucket.list()).objects.length,1);
    assert.equal((await db.prepare('SELECT count(*) n FROM candidate_photo_cleanup').first()).n,0);
  }finally{await local.mf.dispose();}
});

test('concurrent replacements compare the selected photo atomically and retry one request without orphaning objects',async()=>{
  const local=await setup();
  try{
    const {admin,db}=local,bucket=await local.mf.getR2Bucket('PHOTOS');
    let candidate=(await admin('/api/admin/candidates','POST',photo('Concurrent wine'))).body.candidate;
    const before=(await rows(db))[0],raced=await Promise.all([admin(path(candidate),'PUT',replacement(candidate)),admin(path(candidate),'PUT',replacement(candidate))]);
    assert.deepEqual(raced.map(row=>row.status).sort(),[200,409]);candidate=raced.find(row=>row.status===200).body.candidate;
    assert.equal(await bucket.get(before.object_key),null);assert.equal((await bucket.list()).objects.length,1);
    const requestId=crypto.randomUUID(),same=await Promise.all(Array.from({length:4},()=>admin(path(candidate),'PUT',replacement(candidate,0,requestId))));
    assert(same.every(row=>row.status===200),JSON.stringify(same));assert.equal(new Set(same.map(row=>row.body.candidate.photoUrl)).size,1);assert.equal((await bucket.list()).objects.length,1);
    assert.equal((await db.prepare('SELECT count(*) n FROM candidate_photo_cleanup').first()).n,0);
    const stale=await admin(path(candidate),'PUT',replacement(candidate));assert.equal(stale.status,409);assert.equal(stale.body.code,'photo_changed');
    assert.equal((await admin(path(same[0].body.candidate),'PUT',replacement(same[0].body.candidate,1))).body.code,'revision_changed');
  }finally{await local.mf.dispose();}
});

test('replacement rejects invalid payloads and keeps photos referenced by other live candidates or legacy snapshots',async()=>{
  const local=await setup();
  try{
    const {admin,db}=local,bucket=await local.mf.getR2Bucket('PHOTOS'),candidate=(await admin('/api/admin/candidates','POST',photo('Original'))).body.candidate;
    const before=await rows(db),key=before[0].object_key;
    for(const [file,status] of [[new File(['bad'],'bad.png',{type:'image/png'}),415],[new File([PNG],'bad.jpg',{type:'image/jpeg'}),415],[new File([new Uint8Array(5*1024*1024+1)],'big.png',{type:'image/png'}),413]]){const form=replacement(candidate);form.set('file',file);assert.equal((await admin(path(candidate),'PUT',form)).status,status);}
    const missing=replacement(candidate);missing.delete('expectedPhotoUrl');assert.equal((await admin(path(candidate),'PUT',missing)).status,400);
    assert.equal((await client(local.mf)(path(candidate),'PUT',replacement(candidate))).status,401);
    assert.equal((await admin(path(candidate),'PUT',replacement(candidate),{headers:{Origin:'https://evil.test'}})).status,403);
    assert.equal((await admin(path(candidate),'PUT',{})).status,415);assert.deepEqual(await rows(db),before);assert.equal((await bucket.list()).objects.length,1);
    await db.prepare("INSERT INTO candidates(id,number,name,object_key,content_type,request_id) VALUES('shared-wine',2,'Shared',?,'image/png','shared-key')").bind(key).run();
    assert.equal((await admin(path(candidate),'PUT',replacement(candidate))).status,200);assert(await bucket.get(key));assert.equal(await db.prepare('SELECT * FROM candidate_photo_cleanup WHERE object_key=?').bind(key).first(),null);
    await db.prepare("INSERT INTO vote_history VALUES('preserved-history',-1,'old',?)").bind(JSON.stringify({rows:[{object_key:key}]})).run();
    const shared=(await admin('/api/admin/state')).body.candidates.find(row=>row.id==='shared-wine');
    assert.equal((await admin(path(shared),'PUT',replacement(shared))).status,200);assert(await bucket.get(key));assert.equal(await db.prepare('SELECT * FROM candidate_photo_cleanup WHERE object_key=?').bind(key).first(),null);
    await db.prepare('INSERT INTO candidate_photo_cleanup VALUES(?)').bind(key).run();assert.equal((await admin('/api/admin/candidates/cleanup','POST',{})).status,200);assert(await bucket.get(key));
    const migration=await readFile(new URL('../migrations/0011_candidate_photo_replace.sql',import.meta.url),'utf8');assert.equal(migration,await readFile(new URL('../migrations-existing/0022_candidate_photo_replace.sql',import.meta.url),'utf8'));
    await db.prepare("UPDATE activities SET started_at='started',status='open' WHERE id='byob'").run();
    for(const change of ["name='Locked'","description='Locked'","id='changed'","number=100","request_id='changed'"])await assert.rejects(db.prepare('UPDATE candidates SET '+change+" WHERE id='shared-wine'").run(),/candidates_locked/);
  }finally{await local.mf.dispose();}
});

test('upload failures, stale auth or rounds and ambiguous committed writes preserve the current photo',async()=>{
  const local=await setup();
  try{
    const {admin,db}=local,bucket=await local.mf.getR2Bucket('PHOTOS');let candidate=(await admin('/api/admin/candidates','POST',photo('Failure wine'))).body.candidate;
    const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['node:*'],loader:{'.sql':'text'}}),worker=(await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default;
    const version=(await db.prepare('SELECT version FROM admin_credentials').first()).version,cookie=local.auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const baseEnv={DB:db,PHOTOS:bucket,PASSWORD_VERIFIER:{idFromName:value=>value,get:()=>({fetch:async()=>Response.json({version})})}};
    const direct=async(form,overrides={})=>{const request=new Request('https://vote.test'+path(candidate),{method:'PUT',headers:{Origin:'https://vote.test',Cookie:cookie},body:form});const response=await worker.fetch(request,{...baseEnv,...overrides});return {status:response.status,body:await response.json()};};
    const original=(await rows(db))[0];
    const failed=await direct(replacement(candidate),{PHOTOS:{put:async()=>{throw Error('Synthetic R2 outage');},delete:keys=>bucket.delete(keys)}});assert.equal(failed.status,500);assert.deepEqual((await rows(db))[0],original);assert(await bucket.get(original.object_key));
    const changedRound=await direct(replacement(candidate),{PHOTOS:{put:async(...args)=>{await bucket.put(...args);await db.prepare("UPDATE activities SET revision=revision+1 WHERE id='byob'").run();},delete:keys=>bucket.delete(keys)}});assert.equal(changedRound.status,409);assert.equal(changedRound.body.code,'revision_changed');assert.deepEqual((await rows(db))[0],original);assert.equal((await bucket.list()).objects.length,1);
    await db.prepare("UPDATE activities SET revision=0 WHERE id='byob'").run();
    let committed=false;const DB={batch:statements=>db.batch(statements),prepare(sql){const statement=db.prepare(sql);if(!sql.startsWith('UPDATE candidates SET object_key='))return statement;return {bind(...args){const bound=statement.bind(...args);return {async first(){const row=await bound.first();committed=!!row;throw Error('Synthetic response failure after commit');}};}};}};
    const requestId=crypto.randomUUID(),ambiguous=await direct(replacement(candidate,0,requestId),{DB});assert.equal(ambiguous.status,500);assert(committed);const saved=(await rows(db))[0];assert.notEqual(saved.object_key,original.object_key);assert(await bucket.get(saved.object_key));
    const retried=await direct(replacement(candidate,0,requestId));assert.equal(retried.status,200);assert.equal(retried.body.reused,true);candidate=retried.body.candidate;
    await admin('/api/admin/candidates/cleanup','POST',{});assert.equal((await bucket.list()).objects.length,1);
    const revoked=await direct(replacement(candidate),{PHOTOS:{put:async(...args)=>{await bucket.put(...args);await db.prepare("DELETE FROM sessions WHERE role='admin'").run();},delete:keys=>bucket.delete(keys)}});assert.equal(revoked.status,401);assert.equal((await rows(db))[0].object_key,saved.object_key);assert.equal((await bucket.list()).objects.length,1);
  }finally{await local.mf.dispose();}
});

test('opaque member poll photo replacement requires its current owner and member CSRF token',async()=>{
  const bindings={SUPERADMIN_EMAIL:'owner@example.test'},local=await createApp({bindings});
  try{
    const owner=client(local.mf),other=client(local.mf),auth=await owner('/api/members/login','POST',{email:bindings.SUPERADMIN_EMAIL,password:TEST_PASSWORD}),csrf=auth.body.csrfToken;
    const poll=(await owner('/api/members/polls','POST',{title:'Scoped photos',requestId:'scoped-photo-poll'},{headers:{'x-member-csrf':csrf}})).body.poll,base=`/v/${poll.slug}/api`;
    const candidate=(await owner(base+'/admin/candidates','POST',photo('Scoped wine'),{headers:{'x-member-csrf':csrf}})).body.candidate;
    const url=base+path(candidate).slice(4);
    const signed=await other('/api/members/signup','POST',{email:'other@example.test',password:'8'});await owner(`/api/members/requests/${signed.body.member.id}/approve`,'POST',{}, {headers:{'x-member-csrf':csrf}});const otherSession=await other('/api/members/session');
    assert.equal((await other(url,'PUT',replacement(candidate),{headers:{'x-member-csrf':otherSession.body.csrfToken}})).status,403);
    assert.equal((await owner(url,'PUT',replacement(candidate))).status,403);
    const response=await owner(url,'PUT',replacement(candidate),{headers:{'x-member-csrf':csrf}});assert.equal(response.status,200,JSON.stringify(response.body));assert.match(response.body.candidate.photoUrl,new RegExp(`^${base}/photos/.*\\?v=[a-f0-9]{32}$`));
    assert.equal((await local.db.prepare(`SELECT count(*) n FROM m_${poll.slug}_candidates`).first()).n,1);
    assert.equal((await local.db.prepare('SELECT count(*) n FROM candidates').first()).n,0);
  }finally{await local.mf.dispose();}
});
