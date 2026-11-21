import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createApp,client,TEST_PASSWORD } from './harness.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const state=async admin=>{const response=await admin('/api/admin/state');assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
async function login(admin){assert.equal((await admin('/api/admin/login','POST',{password:TEST_PASSWORD})).status,200);}
async function addWine(admin){const response=await admin('/api/admin/candidates','POST',{name:'Aggregate candidate',requestId:'aggregate-candidate',revision:0});assert.equal(response.status,200);return response.body.candidate.id;}
function assertHostPrivacy(value){
  if(!value || typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){
    assert(!['ranking','payload','ballots','voters','choices'].includes(key),`Host response leaked ${key}`);
    assertHostPrivacy(child);
  }
}

test('free entry records joined names and submitted flags, preserves duplicate identity, hides choices and retires roster writes',async()=>{
  const local=await createApp();
  try{
    const admin=client(local.mf),first=client(local.mf),duplicate=client(local.mf),second=client(local.mf),anon=client(local.mf);
    await login(admin);const wine=await addWine(admin);
    assert.deepEqual((await state(admin)).participants,[]);
    const names=await Promise.all([first('/api/session','POST',{name:'  Same   Person  '}),duplicate('/api/session','POST',{name:'same person'})]);
    assert(names.every(response=>response.status===200));assert.equal(names[0].body.participant.id,names[1].body.participant.id);
    const firstId=names[0].body.participant.id;
    const joined=await second('/api/session','POST',{name:'Second person'});assert.equal(joined.status,200);
    let current=await state(admin);assert.equal(current.participants.length,2);assert.equal(current.submittedCount,0);
    assert(current.participants.every(person=>person.submitted.byob===false));assertHostPrivacy(current);
    assert.equal((await admin('/api/admin/activities/byob/state','POST',{action:'open',revision:0})).status,200);
    assert.equal((await first('/api/activities/byob/answer','PUT',{ranking:[wine],revision:0})).status,200);
    current=await state(admin);assert.equal(current.submittedCount,1);
    assert.equal(current.participants.find(person=>person.id===firstId).submitted.byob,true);
    assert.equal(current.participants.find(person=>person.id===joined.body.participant.id).submitted.byob,false);
    assert.deepEqual(current.answers,{byob:[{participantId:firstId}]});assertHostPrivacy(current);
    assert.equal((await admin('/api/activities/byob')).status,401);
    assert.deepEqual((await duplicate('/api/activities/byob')).body.mine,{ranking:[wine]});
    const before=(await local.db.prepare('SELECT * FROM participants ORDER BY id').all()).results;
    for(const [path,method,data] of [
      ['/api/admin/participants','POST',{names:['Forbidden admin import']}],
      ['/api/admin/participants','DELETE',{confirm:'delete',expectedRosterRevision:current.rosterRevision}],
      [`/api/admin/participants/${firstId}`,'PATCH',{name:'Forbidden rename'}],
      [`/api/admin/participants/${firstId}`,'DELETE',{confirm:'delete'}]
    ]){const response=await admin(path,method,data);assert.equal(response.status,410);assert.equal(response.body.code,'roster_read_only');}
    assert.deepEqual((await local.db.prepare('SELECT * FROM participants ORDER BY id').all()).results,before);
    assert.equal((await admin('/api/admin/settings','PATCH',{event:{participationMode:'restricted'}})).status,400);
    assert.equal((await admin('/api/admin/settings','PATCH',{event:{participationMode:'open'}})).status,200);
    assert.equal((await first('/api/session','DELETE')).status,200);
    await local.db.prepare("UPDATE sessions SET expires_at=0 WHERE role='participant'").run();
    assert.equal((await anon('/api/session','POST',{name:'Third person'})).status,200);
    assert.equal((await state(admin)).participants.length,3);assert.equal((await state(admin)).submittedCount,1);
    assert.equal((await admin('/api/admin/activities/byob/state','POST',{action:'close',revision:0})).status,200);
    current=await state(admin);
    assertHostPrivacy(current.byobResults);
    assert.equal((await admin('/api/admin/history','POST',{expectedRevision:0,expectedRosterRevision:current.rosterRevision})).status,404);
    assert.equal((await admin('/api/admin/activities/byob/reset','POST',{confirm:'reset',expectedRevision:0})).status,200);
    current=await state(admin);assert.equal(current.participants.length,3);assert.equal(current.submittedCount,0);assert(current.participants.every(person=>!person.submitted.byob));
    assert.equal((await admin('/api/admin/reset-all','POST',{confirm:'reset-all',expectedRevision:1,expectedRosterRevision:current.rosterRevision})).status,200);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM participant_entries').first()).n,0);
    assert.deepEqual((await state(admin)).participants,[]);
    assert.equal((await admin('/api/admin/history')).status,404);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await local.mf.dispose();}
});

test('failed participant-session creation rolls back the new name and preserves the previously active name',async()=>{
  const local=await createApp();
  try{
    const person=client(local.mf);
    const joined=await person('/api/session','POST',{name:'Previously joined'});assert.equal(joined.status,200);
    const before={participants:(await local.db.prepare('SELECT * FROM participants').all()).results,sessions:(await local.db.prepare('SELECT * FROM sessions').all()).results,entries:(await local.db.prepare('SELECT * FROM participant_entries').all()).results};
    await local.db.prepare("CREATE TRIGGER synthetic_session_failure BEFORE INSERT ON sessions WHEN NEW.role='participant' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END").run();
    assert.equal((await person('/api/session','POST',{name:'Must not appear'})).status,500);
    assert.deepEqual((await local.db.prepare('SELECT * FROM participants').all()).results,before.participants);
    assert.deepEqual((await local.db.prepare('SELECT * FROM sessions').all()).results,before.sessions);
    assert.deepEqual((await local.db.prepare('SELECT * FROM participant_entries').all()).results,before.entries);
    assert.equal((await person('/api/bootstrap')).body.participant.id,joined.body.participant.id);
    await local.db.prepare('DROP TRIGGER synthetic_session_failure').run();
    assert.equal((await person('/api/session','POST',{name:'Now joined'})).status,200);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM participant_entries').first()).n,2);
  }finally{await local.mf.dispose();}
});

test('additive migration identifies surviving legacy join evidence without rewriting rosters, restricted settings or other activities',async()=>{
  const migration=await readFile(new URL('../migrations/0006_participant_entries.sql',import.meta.url),'utf8');
  assert.equal(await readFile(new URL('../migrations-existing/0017_participant_entries.sql',import.meta.url),'utf8'),migration);
  const local=await createApp({legacy:true});
  try{
    const admin=client(local.mf);await login(admin);const wine=await addWine(admin);
    await local.db.prepare('DROP TRIGGER participant_session_entry').run();await local.db.prepare('DROP TABLE participant_entries').run();
    const oldToken='3'.repeat(64);
    await local.db.batch([
      ...['never','expired','voted','other','old-cookie'].map(id=>local.db.prepare('INSERT INTO participants VALUES(?,?,?)').bind(id,`Legacy ${id}`,`legacy ${id}`)),
      local.db.prepare("INSERT INTO sessions VALUES('expired-session','participant','expired',0,NULL)"),
      local.db.prepare("INSERT INTO sessions VALUES(?,'participant','old-cookie',?,NULL)").bind(digest(oldToken),Date.now()+3600000),
      local.db.prepare("UPDATE event SET participation_mode='restricted'"),
      local.db.prepare("UPDATE activities SET status='open',started_at='legacy-start' WHERE id='byob'"),
      local.db.prepare("INSERT INTO answers VALUES('byob','voted',?,'legacy-time')").bind(JSON.stringify({ranking:[wine]})),
      local.db.prepare("UPDATE activities SET status='open',started_at='legacy-start',actual=100 WHERE id='price'"),
      local.db.prepare("INSERT INTO answers VALUES('price','other','{\"price\":100}','legacy-time')")
    ]);
    const tables=['participants','sessions','answers','event','activities','candidates','vote_history'];
    const dump=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
    const before=await dump();
    for(const statement of migration.split(/;\s*(?:\r?\n|$)/).map(value=>value.trim()).filter(Boolean))await local.db.prepare(statement).run();
    assert.deepEqual(await dump(),before);
    assert.deepEqual((await local.db.prepare('SELECT participant_id FROM participant_entries ORDER BY participant_id').all()).results.map(row=>row.participant_id),['expired','old-cookie','voted']);
    let current=await state(admin);assert.equal(current.event.participationMode,'open');assert.equal(current.submittedCount,1);assertHostPrivacy(current);
    assert.deepEqual(new Set(current.participants.map(person=>person.id)),new Set(['expired','old-cookie','voted']));
    assert.equal(current.participants.find(person=>person.id==='voted').submitted.byob,true);
    assert.equal((await client(local.mf,`__Host-byob_participant=${oldToken}`)('/api/bootstrap')).body.participant.id,'old-cookie');
    const newcomer=client(local.mf);assert.equal((await newcomer('/api/session','POST',{name:'Not preregistered'})).status,200);
    assert.equal((await newcomer('/api/session','POST',{name:'Legacy never'})).body.participant.id,'never');
    current=await state(admin);assert.equal(current.participants.length,5);assert(!current.participants.some(person=>person.id==='other'));
    assert.equal((await local.db.prepare('SELECT participation_mode FROM event').first()).participation_mode,'restricted');
    assert.deepEqual((await local.db.prepare("SELECT * FROM answers WHERE activity_id<>'byob'").all()).results,before.answers.filter(row=>row.activity_id!=='byob'));
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await local.mf.dispose();}
});
