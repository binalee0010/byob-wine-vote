import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { client, createApp, TEST_PASSWORD, photo, PNG } from './harness.mjs';

const bindings={SUPERADMIN_EMAIL:'owner@example.test'},password='8';
function memberClient(mf) {
  const api=client(mf);let csrf='';
  return async (path,method='GET',data,options={})=>{
    const response=await api(path,method,data,{...options,headers:{'x-member-csrf':csrf,...options.headers}});
    if(response.body?.csrfToken)csrf=response.body.csrfToken;
    return response;
  };
}
async function ownerLogin(owner) {
  const response=await owner('/api/members/login','POST',{email:bindings.SUPERADMIN_EMAIL,password:TEST_PASSWORD});
  assert.equal(response.status,200,JSON.stringify(response.body));return response;
}
async function approved(owner,member,email) {
  const signed=await member('/api/members/signup','POST',{email,password});
  assert.equal(signed.status,201,JSON.stringify(signed.body));
  assert.equal((await owner(`/api/members/requests/${signed.body.member.id}/approve`,'POST',{})).status,200);
  const session=await member('/api/members/session');assert.equal(session.body.member.status,'approved');
  return signed.body.member;
}
const base=slug=>`/v/${slug}/api`;
async function state(api,slug){const response=await api(`${base(slug)}/admin/state`);assert.equal(response.status,200,JSON.stringify(response.body));return response.body;}
const expectation=state=>({expectedRevision:state.activities[0].revision,expectedRosterRevision:state.rosterRevision});

test('two permanent polls isolate participants, ballots, photos, settings, live results, reset and member authorization',async()=>{
  const local=await createApp({bindings});
  try {
    const owner=memberClient(local.mf),member=memberClient(local.mf),other=memberClient(local.mf),pending=memberClient(local.mf),anon=client(local.mf);
    assert.equal((await anon('/api/members/polls')).status,401);
    await ownerLogin(owner);
    assert.deepEqual((await owner('/api/members/polls')).body,{polls:[]});
    const account=await approved(owner,member,'first@example.test');await approved(owner,other,'second@example.test');
    assert.deepEqual((await member('/api/members/polls')).body,{polls:[]});
    assert.equal((await pending('/api/members/signup','POST',{email:'pending@example.test',password})).status,201);
    assert.equal((await pending('/api/members/polls','POST',{title:'Blocked',requestId:'blocked-request'})).status,403);
    for(const data of [{title:'',requestId:'valid-request'}, {title:'x'.repeat(121),requestId:'valid-request'}, {title:'Valid',requestId:'bad'}, {title:'Bad\u0000title',requestId:'valid-request'}])
      assert.equal((await member('/api/members/polls','POST',data)).status,400);
    const create={title:'First gathering',requestId:'first-creation'};
    assert.equal((await member('/api/members/polls','POST',create,{headers:{'x-member-csrf':''}})).status,403);
    assert.equal((await member('/api/members/polls','POST',create,{headers:{Origin:'https://other.test'}})).status,403);
    const concurrent=await Promise.all(Array.from({length:4},()=>member('/api/members/polls','POST',create)));
    assert(concurrent.every(response=>[200,201].includes(response.status)),JSON.stringify(concurrent));
    assert.equal(concurrent.filter(response=>response.status===201).length,1);
    const first=concurrent[0].body.poll;
    assert(concurrent.every(response=>response.body.poll.slug===first.slug && response.body.poll.title===create.title));
    const secondResponse=await member('/api/members/polls','POST',{title:'Second gathering',requestId:'second-creation'});
    assert.equal(secondResponse.status,201);const second=secondResponse.body.poll;
    assert.notEqual(first.slug,second.slug);assert.match(first.slug,/^[a-f0-9]{32}$/);
    assert.equal((await member('/api/members/polls','POST',{...create,title:'Changed retry'})).status,409);
    assert.deepEqual((await other('/api/members/polls')).body,{polls:[]});
    const publicSlugs=new Map();
    for(const poll of [first,second]){
      const initial=await state(member,poll.slug);
      assert.match(initial.participantUrl,/^https:\/\/vote\.test\/v\/[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
      publicSlugs.set(poll.slug,new URL(initial.participantUrl).pathname.split('/').at(-1));
      assert.equal((await state(member,poll.slug)).participantUrl,initial.participantUrl);
      assert.equal(initial.event.title,poll.title);assert.equal(initial.participants.length,0);assert.equal(initial.candidates.length,0);
      assert.equal((await other(`${base(poll.slug)}/admin/state`)).status,403);
      assert.equal((await owner(`${base(poll.slug)}/admin/state`)).status,403);
      assert.equal((await anon(`${base(poll.slug)}/admin/state`)).status,401);
      assert.equal((await other(`${base(publicSlugs.get(poll.slug))}/admin/state`)).status,403);
      const settingsPath=`${base(publicSlugs.get(poll.slug))}/admin/settings`;
      assert.equal((await member(settingsPath,'PATCH',{event:{title:poll.title}},{headers:{'x-member-csrf':''}})).status,403);
      assert.equal((await member(settingsPath,'PATCH',{event:{title:poll.title}})).status,200);
      assert.equal((await anon(`${base(publicSlugs.get(poll.slug))}/results/byob`)).status,403);
    }
    assert.equal(new Set(publicSlugs.values()).size,2);
    const candidates=[];
    for(const [index,poll] of [first,second].entries()){
      const form=photo(`Wine ${index}`);form.set('description',`Information ${index}`);
      const upload=await member(`${base(poll.slug)}/admin/candidates`,'POST',form);assert.equal(upload.status,200);candidates.push(upload.body.candidate);
      assert.equal(upload.body.candidate.description,`Information ${index}`);
      assert.equal((await anon(`${base(publicSlugs.get(poll.slug))}/photos/${upload.body.candidate.id}`)).status,403);
      assert.equal((await member(`${base(poll.slug)}/admin/settings`,'PATCH',{activities:[{id:'byob',revision:0,votingMethod:'winner',resultVisibility:'public'}]})).status,200);
      assert.equal((await member(`${base(poll.slug)}/admin/activities/byob/state`,'POST',{action:'open',revision:0})).status,200);
    }
    const person=client(local.mf);
    const joined=await person(`${base(first.slug)}/session`,'POST',{name:'Person 0'});assert.equal(joined.status,200);
    assert.equal((await person(`${base(publicSlugs.get(first.slug))}/bootstrap`)).body.participant.id,joined.body.participant.id);
    assert.equal((await person(`${base(second.slug)}/activities/byob/answer`,'PUT',{ranking:[candidates[1].id],revision:0})).status,401);
    assert.equal((await person(`${base(first.slug)}/activities/byob/answer`,'PUT',{ranking:[candidates[1].id],revision:0})).status,400);
    assert.equal((await person(`${base(publicSlugs.get(first.slug))}/activities/byob/answer`,'PUT',{ranking:[candidates[0].id],revision:0})).status,200);
    assert.deepEqual((await person(`${base(first.slug)}/activities/byob`)).body.mine,{ranking:[candidates[0].id]});
    assert.equal((await person(`${base(publicSlugs.get(second.slug))}/bootstrap`)).body.participant,null);
    assert.equal((await state(member,first.slug)).submittedCount,1);
    assert.equal((await state(member,second.slug)).submittedCount,0);
    assert.equal((await person(`${base(second.slug)}/session`,'POST',{name:'Person 1'})).status,200);
    assert.equal((await person(`${base(second.slug)}/activities/byob/answer`,'PUT',{ranking:[candidates[1].id],revision:0})).status,200);
    assert.equal((await person(`${base(first.slug)}/bootstrap`)).body.participant.name,'Person 0');
    assert.equal((await person(`${base(second.slug)}/bootstrap`)).body.participant.name,'Person 1');
    assert.equal((await anon(`${base(second.slug)}/photos/${candidates[0].id}`)).status,404);
    for(const poll of [first,second])assert.equal((await member(`${base(poll.slug)}/admin/activities/byob/state`,'POST',{action:'close',revision:0})).status,200);
    for(const [index,poll] of [first,second].entries()){
      const publicResult=await anon(`${base(publicSlugs.get(poll.slug))}/results/byob`);assert.equal(publicResult.status,200);
      assert.deepEqual(publicResult.body.rows.map(row=>[row.candidateId,row.votes,row.rank]),[[candidates[index].id,1,1]]);
      assert.equal((await anon(`${base(publicSlugs.get(poll.slug))}/photos/${candidates[index].id}`)).status,200);
    }
    const firstPublic=base(publicSlugs.get(first.slug));
    assert.equal((await member(firstPublic+'/admin/settings','PATCH',{activities:[{id:'byob',revision:0,resultVisibility:'participants'}]})).status,200);
    assert.equal((await anon(firstPublic+'/results/byob')).status,403);assert.equal((await person(firstPublic+'/results/byob')).status,200);
    assert.equal((await client(local.mf)(firstPublic+'/session','POST',{name:'Never entered'})).status,403);
    assert.equal((await client(local.mf)(firstPublic+'/session','POST',{name:'Person 0'})).body.participant.id,joined.body.participant.id);
    const beforeSecond=await state(member,second.slug);
    assert.equal((await member(`${base(first.slug)}/admin/history`,'POST',expectation(await state(member,first.slug)))).status,404);
    const reset=await member(`${base(first.slug)}/admin/reset-all`,'POST',{...expectation(await state(member,first.slug)),confirm:'reset-all'});
    assert.equal(reset.status,200);assert.equal((await state(member,first.slug)).candidates.length,0);
    assert.deepEqual(await state(member,second.slug),beforeSecond);
    const bucket=await local.mf.getR2Bucket('PHOTOS');
    assert.equal((await bucket.list({prefix:`members/m_${first.slug}/`})).objects.length,0);
    const key=(await bucket.list({prefix:`members/m_${second.slug}/`})).objects[0].key;
    assert.deepEqual(Buffer.from(await (await bucket.get(key)).arrayBuffer()),PNG);
    const listed=(await member('/api/members/polls')).body.polls;
    assert.deepEqual(new Set(listed.map(poll=>poll.slug)),new Set([first.slug,second.slug]));
    assert.equal(listed.find(poll=>poll.slug===first.slug).status,'waiting');assert.equal(listed.find(poll=>poll.slug===second.slug).status,'closed');
    const secondLogin=memberClient(local.mf);
    assert.equal((await secondLogin('/api/members/login','POST',{email:account.email,password})).status,200);
    assert.equal((await state(secondLogin,second.slug)).answers.byob.length,1);
    assert.equal((await member(`${base(first.slug)}/admin/sessions`,'DELETE')).status,200);
    assert.equal((await member(`${base(second.slug)}/admin/state`)).status,401);
    assert.equal((await secondLogin(`${base(second.slug)}/admin/state`)).status,401);
    assert.deepEqual((await other('/api/members/polls')).body,{polls:[]});
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await local.mf.dispose();}
});

test('owner draft photos authenticate globally and stay private from other accounts and anonymous visitors',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf),member=memberClient(local.mf),anon=client(local.mf);
    await ownerLogin(owner);await approved(owner,member,'private-photo@example.test');
    const created=await owner('/api/members/polls','POST',{title:'Owner private draft',requestId:'owner-private'});assert.equal(created.status,201);
    const uploaded=await owner(`${base(created.body.poll.slug)}/admin/candidates`,'POST',photo('Owner draft wine'));
    assert.equal(uploaded.status,200);const photoUrl=uploaded.body.candidate.photoUrl;
    assert.equal((await owner(photoUrl)).status,200);
    assert.equal((await member(photoUrl)).status,403);assert.equal((await anon(photoUrl)).status,403);
    const secondOwner=memberClient(local.mf);await ownerLogin(secondOwner);
    assert.equal((await secondOwner(photoUrl)).status,200);
    assert.deepEqual((await secondOwner('/api/members/polls')).body.polls,[created.body.poll]);
  }finally{await local.mf.dispose();}
});

test('same request and list recover creation after schema or title initialization failure without duplicate polls',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf),member=memberClient(local.mf);await ownerLogin(owner);
    const account=await approved(owner,member,'interrupted@example.test');
    const auth=await member('/api/members/login','POST',{email:account.email,password});
    const cookie=auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['node:*'],loader:{'.sql':'text'}});
    const {default:worker}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    for(const failBatch of [1,2]){
      const data={title:`Recover ${failBatch}`,requestId:`interrupted-${failBatch}`};let batches=0;
      const DB={prepare:sql=>local.db.prepare(sql),async batch(statements){if(++batches===failBatch)throw new Error('Synthetic initialization failure');return local.db.batch(statements);}};
      const response=await worker.fetch(new Request('https://vote.test/api/members/polls',{method:'POST',headers:{Origin:'https://vote.test',Cookie:cookie,'Content-Type':'application/json','x-member-csrf':auth.body.csrfToken},body:JSON.stringify(data)}),{...bindings,DB,PHOTOS:await local.mf.getR2Bucket('PHOTOS')});
      assert.equal(response.status,500);
      const committed=await local.db.prepare('SELECT * FROM member_polls WHERE request_id=?').bind(data.requestId).first();
      assert(committed);assert.equal(committed.initialized,0);
      if(failBatch===2){const listing=await member('/api/members/polls');assert.equal(listing.status,200);assert(listing.body.polls.some(poll=>poll.slug===committed.slug && poll.title===data.title));}
      const retried=await member('/api/members/polls','POST',data);assert.equal(retried.status,200);
      assert.equal(retried.body.poll.slug,committed.slug);assert.equal(retried.body.poll.title,data.title);
      assert.equal((await local.db.prepare('SELECT count(*) AS n FROM member_polls WHERE request_id=?').bind(data.requestId).first()).n,1);
      assert.equal((await state(member,committed.slug)).event.title,data.title);
    }
    assert.equal((await member('/api/members/polls')).body.polls.length,2);
  }finally{await local.mf.dispose();}
});

test('legacy config-only polls stay discoverable while untouched default workspaces stay empty and directly accessible',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf);await ownerLogin(owner);
    const configurations=["UPDATE event SET participation_mode='restricted'","UPDATE activities SET title='Custom question' WHERE id='byob'","UPDATE activities SET voting_method='winner' WHERE id='byob'","UPDATE activities SET rank_points='[5,2]' WHERE id='byob'","UPDATE activities SET publish_on_close=1 WHERE id='byob'"];
    for(const [index,sql] of configurations.entries()){
      const member=memberClient(local.mf),account=await approved(owner,member,`config-${index}@example.test`);
      assert.equal((await state(member,account.workspaceSlug)).candidates.length,0);
      assert.deepEqual((await member('/api/members/polls')).body,{polls:[]});
      const scopedSql=sql.replace(/\bevent\b/g,`m_${account.id}_event`).replace(/\bactivities\b/g,`m_${account.id}_activities`);
      await local.db.prepare(scopedSql).run();
      const listing=await member('/api/members/polls');assert.equal(listing.status,200);assert.equal(listing.body.polls.length,1);assert.equal(listing.body.polls[0].slug,account.workspaceSlug);
    }
    assert.deepEqual((await owner('/api/members/polls')).body,{polls:[]});
  }finally{await local.mf.dispose();}
});

test('listing more than fifty initialized polls batches current titles and statuses without provisioning checks',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf);const auth=await ownerLogin(owner);
    const expected=[];const statements=[];
    for(let index=0;index<55;index++){
      const slug=(index+1).toString(16).padStart(32,'0'),namespace=`m_${slug}`,title=`Current title ${index}`,status=index%2?'closed':'waiting';
      expected.unshift({slug,title,status});
      statements.push(local.db.prepare(`CREATE TABLE ${namespace}_event AS SELECT 1 AS id,? AS title`).bind(title),
        local.db.prepare(`CREATE TABLE ${namespace}_activities AS SELECT 'byob' AS id,? AS status`).bind(status),
        local.db.prepare("INSERT INTO member_polls(slug,member_id,namespace,request_id,creation_title,initialized,created_at) VALUES(?,'owner',?,?,'Original title',1,?)").bind(slug,namespace,`synthetic-${index}`,index));
    }
    await local.db.batch(statements);
    const compiled=await build({entryPoints:['worker/polls.ts'],bundle:true,write:false,format:'esm',platform:'node',loader:{'.sql':'text'}});
    const {memberPolls}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
    const prepared=[];const DB={prepare(sql){prepared.push(sql);return local.db.prepare(sql);},batch:statements=>local.db.batch(statements)};
    const response=await memberPolls(new Request('https://vote.test/api/members/polls'),{...bindings,DB},{...auth.body.member,namespace:null,csrfToken:auth.body.csrfToken},async()=>{throw new Error('GET must not read a body');});
    assert.equal(response.status,200);assert.deepEqual((await response.json()).polls,expected);
    assert.equal(prepared.filter(sql=>sql.includes('FROM (VALUES')).length,2);
    assert(prepared.length<=6,`${prepared.length} queries for 55 ready polls`);
    assert(prepared.every(sql=>!sql.includes('sqlite_master') && !sql.startsWith('CREATE')));
  }finally{await local.mf.dispose();}
});

test('poll creation rejects a member revoked immediately before its atomic registry INSERT',async()=>{
  const local=await createApp({bindings});
  try{
    const owner=memberClient(local.mf),member=memberClient(local.mf);await ownerLogin(owner);
    const account=await approved(owner,member,'race@example.test');
    const auth=await member('/api/members/login','POST',{email:account.email,password});
    const cookie=auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['node:*'],loader:{'.sql':'text'}});
    const {default:worker}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    let revoked=false;
    const DB={batch:statements=>local.db.batch(statements),prepare(sql){const prepared=local.db.prepare(sql);if(!sql.startsWith('INSERT INTO member_polls'))return prepared;
      return {bind(...args){return {async run(){revoked=true;await local.db.prepare('DELETE FROM member_sessions WHERE member_id=?').bind(account.id).run();return prepared.bind(...args).run();}};}};}};
    const response=await worker.fetch(new Request('https://vote.test/api/members/polls',{method:'POST',headers:{Origin:'https://vote.test',Cookie:cookie,'Content-Type':'application/json','x-member-csrf':auth.body.csrfToken},body:JSON.stringify({title:'Must not exist',requestId:'race-request'})}),{...bindings,DB,PHOTOS:await local.mf.getR2Bucket('PHOTOS')});
    assert(revoked);assert.equal(response.status,401);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM member_polls').first()).n,0);
  }finally{await local.mf.dispose();}
});

test('fresh and existing poll migrations preserve original values, votes and archives while allowing closed descriptive correction',async()=>{
  for(const [fresh,existing] of [['0004_candidate_description.sql','0015_candidate_description.sql'],['0005_member_polls.sql','0016_member_polls.sql'],['0007_poll_deletion.sql','0018_poll_deletion.sql']])
    assert.equal(await readFile(new URL(`../migrations/${fresh}`,import.meta.url),'utf8'),await readFile(new URL(`../migrations-existing/${existing}`,import.meta.url),'utf8'));
  const db=new DatabaseSync(':memory:');
  try{
    for(const file of ['0001_initial.sql','0002_members.sql','0003_password_reset.sql'])db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    db.exec("INSERT INTO participants VALUES('person','Original person','original person'); INSERT INTO candidates VALUES('wine',1,'Original wine','candidates/photo','image/png','original-upload'); UPDATE activities SET status='open',started_at='today'; INSERT INTO answers VALUES('byob','person','{\"ranking\":[\"wine\"]}','today'); UPDATE activities SET status='closed',published=1; INSERT INTO vote_history VALUES('history',0,'today','{\"rows\":[{\"id\":\"wine\",\"name\":\"Original wine\",\"object_key\":\"candidates/photo\",\"score\":1}]}');");
    const tables=['event','activities','participants','answers','vote_history','admin_credentials'];
    const before=Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
    const wine=db.prepare('SELECT * FROM candidates').get();
    for(const file of ['0004_candidate_description.sql','0005_member_polls.sql','0007_poll_deletion.sql'])db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    assert.deepEqual(Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()])),before);
    assert.deepEqual({...db.prepare('SELECT * FROM candidates').get()},{...wine,description:''});
    db.prepare("UPDATE candidates SET name='Corrected wine',description='Region, vintage and grape' WHERE id='wine'").run();
    for(const field of ['id','number','object_key','content_type','request_id'])assert.throws(()=>db.prepare(`UPDATE candidates SET ${field}=?`).run(field==='number'?2:'different'),/candidates_locked/);
    assert.throws(()=>db.prepare('DELETE FROM candidates').run(),/candidates_locked/);
    assert.deepEqual(Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()])),before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();}
});

for(const legacy of [false,true])test(`poll-list re-entry retains each poll's live results and optional private memo (${legacy?'existing':'fresh'})`,async()=>{
  const local=await createApp({bindings,legacy});
  try{
    if(legacy)for(const file of ['0002_members.sql','0003_password_reset.sql']){
      const migration=await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8');
      for(const sql of migration.split(/;\s*(?:\r?\n|$)/).map(sql=>sql.trim()).filter(Boolean))await local.db.prepare(sql).run();
    }
    const owner=memberClient(local.mf);await ownerLogin(owner);
    const poll=(await owner('/api/members/polls','POST',{title:'Retained poll',requestId:'retained-poll-request'})).body.poll;
    const other=(await owner('/api/members/polls','POST',{title:'Other poll',requestId:'other-poll-request'})).body.poll;
    const originalOther=await state(owner,other.slug);
    assert.equal(originalOther.event.memo,'');
    const memo='  Private gathering note\nSecond line\tＷｉｎｅ  ';
    assert.equal((await owner(`${base(poll.slug)}/admin/settings`,'PATCH',{event:{memo},activities:[{id:'byob',revision:0,votingMethod:'winner'}]})).status,200);
    const created=await owner(`${base(poll.slug)}/admin/candidates`,'POST',photo('Original wine'));assert.equal(created.status,200);const wine=created.body.candidate;
    assert.equal((await owner(`${base(poll.slug)}/admin/activities/byob/state`,'POST',{action:'open',revision:0})).status,200);
    const person=client(local.mf);assert.equal((await person(`${base(poll.slug)}/session`,'POST',{name:'Participant'})).status,200);
    assert.equal((await person(`${base(poll.slug)}/activities/byob/answer`,'PUT',{ranking:[wine.id],revision:0})).status,200);
    assert.equal((await owner(`${base(poll.slug)}/admin/activities/byob/state`,'POST',{action:'close',revision:0})).status,200);
    const before=await state(owner,poll.slug);assert.equal(before.event.memo,memo);assert.equal(before.submittedCount,1);assert.equal(before.byobResults[0].votes,1);
    const listed=(await owner('/api/members/polls')).body.polls;assert.equal(listed.find(row=>row.slug===poll.slug).status,'closed');assert(listed.every(row=>!Object.hasOwn(row,'memo')));
    assert.equal(Object.hasOwn((await person(`${base(poll.slug)}/bootstrap`)).body.event,'memo'),false);
    assert.deepEqual(await state(owner,listed.find(row=>row.slug===poll.slug).slug),before);
    assert.deepEqual(await state(owner,other.slug),originalOther);
    const secondLogin=memberClient(local.mf);await ownerLogin(secondLogin);
    assert.deepEqual(await state(secondLogin,poll.slug),before);
    assert.equal((await owner(`${base(poll.slug)}/admin/settings`,'PATCH',{event:{title:'Revised title'}})).status,200);
    const renamed=await owner(`${base(poll.slug)}/admin/candidates/names`,'PUT',{revision:0,names:[{id:wine.id,name:'Corrected live wine'}]});assert.equal(renamed.status,200);
    const reread=await state(owner,poll.slug);assert.equal(reread.event.memo,memo);
    assert.deepEqual(reread.byobResults,before.byobResults.map(row=>({...row,name:'Corrected live wine'})));assert.deepEqual(reread.answers,before.answers);assert.deepEqual(reread.participants,before.participants);
    const bucket=await local.mf.getR2Bucket('PHOTOS');assert.equal((await bucket.list()).objects.length,1);
    assert.equal((await owner(wine.photoUrl)).status,200);
    assert.equal((await owner(`${base(poll.slug)}/admin/history`)).status,404);
    assert.equal((await owner(`${base(poll.slug)}/admin/settings`,'PATCH',{event:{memo:''}})).status,200);
    assert.equal((await state(owner,poll.slug)).event.memo,'');
    assert.deepEqual(await state(owner,other.slug),originalOther);
    assert.equal((await owner(`${base(poll.slug)}/admin/activities/byob/state`,'POST',{action:'open',revision:0})).status,200);
    assert.equal((await owner(`${base(poll.slug)}/admin/candidates/names`,'PUT',{revision:0,names:[{id:wine.id,name:'Blocked while open'}]})).status,409);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await local.mf.dispose()}
});
