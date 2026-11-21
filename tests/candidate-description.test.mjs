import test from 'node:test';
import assert from 'node:assert/strict';
import { client,createApp,TEST_PASSWORD,photo,PNG } from './harness.mjs';

for(const legacy of [false,true])test(`closed candidate descriptions preserve votes, ranks, identities and photos (${legacy?'legacy':'fresh'})`,async()=>{
  const local=await createApp({legacy});
  try{
    const admin=client(local.mf),person=client(local.mf),anon=client(local.mf);
    assert.equal((await admin('/api/admin/login','POST',{password:TEST_PASSWORD})).status,200);
    const form=photo('Original wine');form.set('description','Original region');
    const added=await admin('/api/admin/candidates','POST',form);assert.equal(added.status,200);
    const id=added.body.candidate.id;assert.equal(added.body.candidate.description,'Original region');
    const edit=(name,description)=>({revision:0,names:[{id,name,...(description===undefined?{}:{description})}]});
    const path='/api/admin/candidates/names';
    assert.equal((await admin(path,'PUT',edit('Wine before start','Vintage and grapes'))).status,200);
    assert.equal((await admin(path,'PUT',edit('Name only'))).status,200);
    let state=(await admin('/api/admin/state')).body;assert.equal(state.candidates[0].description,'Vintage and grapes');
    await local.db.prepare("UPDATE candidates SET name='  Ｗｉｎｅ   original  ',description='  Ｒｅｇｉｏｎ  '").run();
    assert.equal((await admin(path,'PUT',edit('  Ｗｉｎｅ   original  ','Only description changed'))).status,200);
    assert.equal((await admin('/api/admin/state')).body.candidates[0].name,'  Ｗｉｎｅ   original  ');
    for(const description of [null,2,'x'.repeat(2001),'bad\u0000text'])assert.equal((await admin(path,'PUT',edit('Invalid',description))).status,400);
    assert.equal((await person('/api/session','POST',{name:'Original person'})).status,200);
    assert.equal((await admin('/api/admin/activities/byob/state','POST',{action:'open',revision:0})).status,200);
    assert.equal((await admin(path,'PUT',edit('Forbidden during voting','Do not save'))).status,409);
    assert.equal((await person('/api/activities/byob/answer','PUT',{ranking:[id],revision:0})).status,200);
    assert.equal((await admin('/api/admin/activities/byob/state','POST',{action:'close',revision:0})).status,200);
    state=(await admin('/api/admin/state')).body;
    const before={candidates:(await local.db.prepare('SELECT * FROM candidates').all()).results,answers:(await local.db.prepare('SELECT * FROM answers').all()).results,participants:(await local.db.prepare('SELECT * FROM participants').all()).results,activities:(await local.db.prepare('SELECT * FROM activities ORDER BY id').all()).results};
    assert.equal((await anon(path,'PUT',edit('Unauthorized','No'))).status,401);
    assert.equal((await admin(path,'PUT',edit('Corrected wine','Bordeaux, 2010, Cabernet'))).status,200);
    const after=(await admin('/api/admin/state')).body;
    assert.equal(after.candidates[0].name,'Corrected wine');assert.equal(after.candidates[0].description,'Bordeaux, 2010, Cabernet');
    assert.deepEqual(after.byobResults.map(({name,description,...row})=>row),state.byobResults.map(({name,description,...row})=>row));
    assert.deepEqual((await local.db.prepare('SELECT * FROM candidates').all()).results.map(({name,description,...row})=>row),before.candidates.map(({name,description,...row})=>row));
    for(const table of ['answers','participants','activities'])assert.deepEqual((await local.db.prepare(`SELECT * FROM ${table}${table==='activities'?' ORDER BY id':''}`).all()).results,before[table]);
    assert.equal((await admin('/api/admin/candidates','POST',{name:'New forbidden',requestId:'forbidden-upload',revision:0})).status,409);
    assert.equal((await admin(`/api/admin/candidates/${id}`,'DELETE',{revision:0})).status,409);
    assert.equal((await admin('/api/admin/candidates/order','PUT',{ids:[id],revision:0})).status,409);
    const bucket=await local.mf.getR2Bucket('PHOTOS');assert.equal((await bucket.list()).objects.length,1);
    assert.deepEqual(Buffer.from(await (await bucket.get(before.candidates[0].object_key)).arrayBuffer()),PNG);
    assert.equal((await admin(path,'PUT',edit('Final correction',''))).status,200);
    assert.equal((await admin('/api/admin/state')).body.candidates[0].description,'');
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await local.mf.dispose();}
});
