import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { client, createApp, TEST_PASSWORD, photo, PNG } from './harness.mjs';

const bindings={SUPERADMIN_EMAIL:'owner@example.test'};
function memberClient(mf){const request=client(mf);let csrf='';return async(path,method='GET',data,options={})=>{const response=await request(path,method,data,{...options,headers:{'x-member-csrf':csrf,...options.headers}});if(response.body?.csrfToken)csrf=response.body.csrfToken;return response;};}
const login=owner=>owner('/api/members/login','POST',{email:bindings.SUPERADMIN_EMAIL,password:TEST_PASSWORD});
async function workerModule(){const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['node:*'],loader:{'.sql':'text'}});return (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default;}

test('owner public mapping is additive, random per install and preserves all internal identities and tombstones',async()=>{
  const sql=await readFile(new URL('../migrations/0010_owner_poll_link.sql',import.meta.url),'utf8');
  assert.equal(sql,await readFile(new URL('../migrations-existing/0021_owner_poll_link.sql',import.meta.url),'utf8'));
  const slugs=[];
  for(let index=0;index<2;index++){
    const db=new DatabaseSync(':memory:');
    try{
      for(const name of ['0001_initial.sql','0002_members.sql','0005_member_polls.sql','0007_poll_deletion.sql'])db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
      db.exec("INSERT INTO members(id,email,role,status,workspace_slug,created_at) VALUES('owner','owner@example.test','owner','approved','owner',1); INSERT INTO member_polls(slug,member_id,creation_title,initialized,created_at,deleted_at) VALUES('owner','owner','Preserved',1,1,42)");
      const before=db.prepare('SELECT * FROM member_polls').get(),member=db.prepare('SELECT * FROM members').get();
      const schema=db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
      db.exec(sql);const slug=db.prepare('SELECT slug FROM owner_poll_link WHERE id=1').get().slug;slugs.push(slug);
      assert.match(slug,/^[a-f0-9]{32}$/);assert.deepEqual(db.prepare('SELECT * FROM member_polls').get(),before);assert.deepEqual(db.prepare('SELECT * FROM members').get(),member);
      const oldNames=new Set(schema.map(row=>row.name));assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().filter(row=>oldNames.has(row.name)),schema);
      assert.throws(()=>db.prepare("UPDATE members SET workspace_slug=? WHERE id='owner'").run(slug),/CHECK/);
      assert.throws(()=>db.exec("INSERT INTO owner_poll_link VALUES(2,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')"),/CHECK/);
    }finally{db.close();}
  }
  assert.notEqual(slugs[0],slugs[1]);
});

test('opaque owner address is stable for sessions, poll lists, photos, ballots and name reconnection while old public routes reveal nothing',async()=>{
  const local=await createApp({bindings,publicOrigin:'https://canonical.example.test'});
  try{
    const slug=(await local.db.prepare('SELECT slug FROM owner_poll_link WHERE id=1').first()).slug,base=`/v/${slug}/api`;
    const owner=memberClient(local.mf),person=client(local.mf),anon=client(local.mf),other=memberClient(local.mf);
    assert.equal(await local.db.prepare("SELECT id FROM members WHERE id='owner'").first(),null);
    assert.equal((await anon(base+'/bootstrap')).status,200);
    assert.equal((await login(owner)).body.member.workspaceSlug,slug);
    assert.equal((await owner('/api/members/session')).body.member.workspaceSlug,slug);
    const added=await owner(base+'/admin/candidates','POST',photo('Preserved wine'));assert.equal(added.status,200);const wine=added.body.candidate;
    assert.equal(wine.photoUrl,base+'/photos/'+wine.id);
    assert.equal((await owner(base+'/admin/settings','PATCH',{event:{title:'Existing owner gathering'},activities:[{id:'byob',revision:0,votingMethod:'winner',resultVisibility:'public'}]})).status,200);
    assert.equal((await owner(base+'/admin/activities/byob/state','POST',{action:'open',revision:0})).status,200);
    const joined=await person(base+'/session','POST',{name:'Original person'});assert.equal(joined.status,200);const id=joined.body.participant.id;
    assert.equal((await person(base+'/activities/byob/answer','PUT',{ranking:[wine.id],revision:0})).status,200);
    assert.equal((await owner(base+'/admin/activities/byob/state','POST',{action:'close',revision:0})).status,200);
    const before=(await local.db.prepare('SELECT * FROM answers').all()).results;
    const listed=await owner('/api/members/polls');assert.deepEqual(listed.body.polls,[{slug,title:'Existing owner gathering',status:'closed'}]);
    const internal=await local.db.prepare("SELECT * FROM member_polls WHERE slug='owner'").first();assert.equal(internal.namespace,null);assert.equal(internal.member_id,'owner');
    assert.equal((await person(base+'/bootstrap')).body.participant.submitted.byob,true);
    const reconnected=await client(local.mf)(base+'/session','POST',{name:'Original person'});assert.equal(reconnected.body.participant.id,id);
    assert.equal((await person(wine.photoUrl)).status,200);
    assert.deepEqual(Buffer.from(await (await (await local.mf.getR2Bucket('PHOTOS')).get((await local.db.prepare('SELECT object_key FROM candidates').first()).object_key)).arrayBuffer()),PNG);
    const adminState=(await owner(base+'/admin/state')).body;assert.equal(adminState.participantUrl,`https://canonical.example.test/v/${slug}`);assert.equal(adminState.submittedCount,1);
    assert.equal((await owner('/api/admin/state')).body.participantUrl,adminState.participantUrl);
    await other('/api/members/signup','POST',{email:'other@example.test',password:'8'});
    const otherId=(await other('/api/members/session')).body.member.id;await owner(`/api/members/requests/${otherId}/approve`,'POST',{});await other('/api/members/session');
    assert.equal((await other(base+'/admin/state')).status,403);assert.equal((await anon(base+'/admin/state')).status,401);
    for(const api of [anon,person,owner,other])for(const path of ['/v/owner','/v/owner/','/v/owner/api/bootstrap','/v/owner/api/photos/'+wine.id,'/v/owner/api/results/byob','/api/bootstrap','/api/photos/'+wine.id,'/api/results/byob','/api/activities/byob']){
      const response=await api(path);assert.equal(response.status,404,path);assert.equal(response.headers.get('location'),null);assert(!JSON.stringify(response.body).includes(slug),path);
    }
    for(const path of ['/api/session','/v/owner/api/session'])assert.equal((await person(path,'POST',{name:'Blocked'})).status,404);
    assert.deepEqual((await local.db.prepare('SELECT * FROM answers').all()).results,before);
    assert.equal((await local.db.prepare('SELECT slug FROM owner_poll_link WHERE id=1').first()).slug,slug);
    assert.equal((await anon('/api/mode')).body.ownerUrl,undefined);assert(!JSON.stringify((await anon('/api/members/session')).body).includes(slug));
    const credentials=await local.db.prepare('SELECT * FROM admin_credentials').first();
    const removed=await owner('/api/members/polls/'+slug,'DELETE',{confirm:'delete-poll'});assert.deepEqual(removed.body,{ok:true,slug});
    assert.equal((await owner('/api/members/polls/'+slug,'DELETE',{confirm:'delete-poll'})).status,200);
    assert.equal((await owner(base+'/admin/state')).status,404);assert.equal((await person(base+'/bootstrap')).status,404);assert.equal((await owner('/api/admin/state')).status,404);
    assert.deepEqual((await owner('/api/members/polls')).body.polls,[]);assert.equal((await owner('/api/members/session')).body.authenticated,true);
    assert.deepEqual(await local.db.prepare('SELECT * FROM admin_credentials').first(),credentials);assert.deepEqual((await local.db.prepare('SELECT * FROM answers').all()).results,before);
    assert((await local.db.prepare("SELECT deleted_at FROM member_polls WHERE slug='owner'").first()).deleted_at>0);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await local.mf.dispose();}
});

test('short opaque HTML routes work and old admin bookmarks return only to the authenticated list flow',async()=>{
  const local=await createApp({bindings});
  try{
    const slug=(await local.db.prepare('SELECT slug FROM owner_poll_link WHERE id=1').first()).slug,worker=await workerModule();
    const env={...bindings,DB:local.db,PHOTOS:await local.mf.getR2Bucket('PHOTOS'),ASSETS:{fetch:async()=>new Response('<!doctype html><title>Vote</title>',{headers:{'Content-Type':'text/html'}})}};
    for(const path of [`/v/${slug}`,`/v/${slug}/`,`/admin/p/${slug}`]){const response=await worker.fetch(new Request('https://vote.test'+path),env);assert.equal(response.status,200,path);assert.match(await response.text(),/<title>Vote/);}
    for(const path of ['/admin/p/owner','/admin/p/owner/']){const response=await worker.fetch(new Request('https://vote.test'+path),env);assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://vote.test/admin');assert(!(await response.text()).includes(slug));}
    for(const path of ['/v/owner','/v/owner/api/bootstrap'])assert.equal((await worker.fetch(new Request('https://vote.test'+path),env)).status,404);
  }finally{await local.mf.dispose();}
});
