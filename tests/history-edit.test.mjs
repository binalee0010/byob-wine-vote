import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, client, TEST_PASSWORD, photo } from './harness.mjs';

for (const legacy of [false, true]) test(`retired archive CRUD and photo routes preserve live and existing stored data (${legacy ? 'legacy' : 'fresh'})`, async () => {
  const local = await createApp({ legacy });
  try {
    const admin = client(local.mf), person = client(local.mf), anonymous = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    assert.equal((await person('/api/session', 'POST', { name: 'Synthetic person' })).status, 200);
    const uploaded = await admin('/api/admin/candidates', 'POST', photo('Original wine'));
    assert.equal(uploaded.status, 200); const candidate = uploaded.body.candidate;
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    assert.equal((await person('/api/activities/byob/answer', 'PUT', { ranking: [candidate.id], revision: 0 })).status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'close', revision: 0 })).status, 200);
    await local.db.prepare("INSERT INTO vote_history VALUES('existing-history',0,'today',?)").bind(JSON.stringify({ rows: [{ id: candidate.id, object_key: 'existing-photo', score: 1 }] })).run();
    const tables = ['event', 'activities', 'participants', 'answers', 'candidates', 'vote_history'];
    const dump = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
    const before = await dump(), state = (await admin('/api/admin/state')).body;
    const bucket = await local.mf.getR2Bucket('PHOTOS'), keys = (await bucket.list()).objects.map(object => object.key);
    for (const [path, method] of [
      ['/api/admin/history', 'GET'], ['/api/admin/history', 'POST'],
      ['/api/admin/history/existing-history', 'GET'], ['/api/admin/history/existing-history', 'PUT'], ['/api/admin/history/existing-history', 'DELETE'],
      [`/api/admin/history/existing-history/photos/${candidate.id}`, 'GET']
    ]) assert.equal((await admin(path, method, method === 'GET' ? undefined : { expectedRevision: 0, expectedVersion: 'a'.repeat(64), confirm: 'delete-history', title: 'Changed', names: [] })).status, 404, `${method} ${path}`);
    assert.equal((await anonymous('/api/admin/history')).status, 401);
    assert.equal((await person('/api/admin/history/existing-history')).status, 401);
    assert.equal(state.activities[0].resultsLocked, true);
    assert.equal(state.byobResults[0].points, 1);
    assert.equal(Object.hasOwn(state, 'currentHistoryId'), false);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 409);
    assert.deepEqual(await dump(), before);
    assert.deepEqual((await admin('/api/admin/state')).body, state);
    assert.deepEqual((await bucket.list()).objects.map(object => object.key), keys);
    assert.equal((await admin(candidate.photoUrl)).status, 200);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});
