import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, client, TEST_PASSWORD, photo } from './harness.mjs';

for (const legacy of [false, true]) test(`archive edits and deletion preserve photos, scores and other records (${legacy ? 'legacy' : 'fresh'})`, async () => {
  const local = await createApp({ legacy });
  try {
    const admin = client(local.mf), person = client(local.mf), anonymous = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    assert.equal((await person('/api/session', 'POST', { name: 'Synthetic person' })).status, 200);
    const uploaded = await admin('/api/admin/candidates', 'POST', photo('Original wine'));
    const candidate = uploaded.body.candidate;
    assert.equal(uploaded.status, 200);
    const state = async () => (await admin('/api/admin/state')).body;
    const save = async revision => {
      assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision })).status, 200);
      assert.equal((await person('/api/activities/byob/answer', 'PUT', { ranking: [candidate.id], revision })).status, 200);
      assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'close', revision })).status, 200);
      const current = await state();
      const saved = await admin('/api/admin/history', 'POST', { expectedRevision: revision, expectedRosterRevision: current.rosterRevision });
      assert.equal(saved.status, 200);
      return saved.body.id;
    };
    const firstId = await save(0);
    assert.equal((await admin('/api/admin/activities/byob/reset', 'POST', { confirm: 'reset', expectedRevision: 0 })).status, 200);
    const secondId = await save(1);
    const path = `/api/admin/history/${firstId}`;
    const before = (await admin(path)).body.record;
    const second = (await admin(`/api/admin/history/${secondId}`)).body.record;
    const activeBefore = await state();
    const rawBefore = await local.db.prepare('SELECT * FROM vote_history WHERE id=?').bind(firstId).first();
    const snapshot = JSON.parse(rawBefore.snapshot);
    const payload = { expectedVersion: before.version, title: 'Updated gathering', names: [{ id: candidate.id, name: 'Updated wine' }] };
    assert.equal((await anonymous(path, 'PUT', payload)).status, 401);
    assert.equal((await person(path, 'PUT', payload)).status, 401);
    assert.equal((await admin(path, 'PUT', payload, { headers: { Origin: 'https://other.test' } })).status, 403);
    for (const patch of [
      { expectedVersion: '' }, { title: '' }, { title: 'a'.repeat(161) }, { names: null },
      { names: [{ id: 'missing', name: 'Unknown' }] }, { names: [{ id: candidate.id, name: '' }] },
      { names: [{ id: candidate.id, name: 'a'.repeat(161) }] },
      { names: [{ id: candidate.id, name: 'A' }, { id: candidate.id, name: 'B' }] }
    ]) assert.equal((await admin(path, 'PUT', { ...payload, ...patch })).status, 400);
    assert.deepEqual((await admin(path)).body.record, before);
    const edits = await Promise.all([
      admin(path, 'PUT', payload),
      admin(path, 'PUT', { ...payload, title: 'Concurrent gathering', names: [{ id: candidate.id, name: 'Concurrent wine' }] })
    ]);
    assert.deepEqual(edits.map(response => response.status).sort(), [200, 409]);
    const edited = edits.find(response => response.status === 200).body.record;
    assert.notEqual(edited.version, before.version);
    assert.deepEqual(edited.rows.map(({ name, ...row }) => row), before.rows.map(({ name, ...row }) => row));
    assert.deepEqual(await state(), activeBefore);
    assert.deepEqual((await admin(`/api/admin/history/${secondId}`)).body.record, second);
    const rawAfter = await local.db.prepare('SELECT * FROM vote_history WHERE id=?').bind(firstId).first();
    assert.deepEqual({ ...rawAfter, snapshot: rawBefore.snapshot }, rawBefore);
    const changedSnapshot = JSON.parse(rawAfter.snapshot);
    assert.deepEqual({ ...changedSnapshot, title: snapshot.title, rows: changedSnapshot.rows.map((row, index) => ({ ...row, name: snapshot.rows[index].name })) }, snapshot);
    assert.equal((await admin(path, 'DELETE', { expectedVersion: before.version, confirm: 'delete-history' })).body.code, 'history_changed');
    assert.equal((await admin(path, 'DELETE', { expectedVersion: edited.version })).status, 400);
    assert.equal((await person(path, 'DELETE', { expectedVersion: edited.version, confirm: 'delete-history' })).status, 401);
    const bucket = await local.mf.getR2Bucket('PHOTOS');
    const photoKeys = (await bucket.list()).objects.map(object => object.key);
    assert.equal((await admin(path, 'DELETE', { expectedVersion: edited.version, confirm: 'delete-history' })).status, 200);
    assert.equal((await admin(path)).status, 404);
    assert.equal((await admin(`${path}/photos/${candidate.id}`)).status, 404);
    assert.deepEqual((await bucket.list()).objects.map(object => object.key), photoKeys);
    assert.deepEqual((await admin(`/api/admin/history/${secondId}`)).body.record, second);
    assert.equal((await admin(`/api/admin/history/${secondId}/photos/${candidate.id}`)).status, 200);
    assert.equal((await admin(candidate.photoUrl)).status, 200);
    assert.deepEqual(await state(), activeBefore);
    assert.deepEqual((await admin('/api/admin/history')).body.records.map(row => row.id), [secondId]);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});

test('an archive with 101 wines permits all names to change without altering photo keys or results', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    for (let index = 0; index < 101; index++) {
      const candidate = index === 0 ? photo('Wine 0') : { name: `Wine ${index}`, requestId: `synthetic-large-${index}`, revision: 0 };
      assert.equal((await admin('/api/admin/candidates', 'POST', candidate)).status, 200);
    }
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'close', revision: 0 })).status, 200);
    const state = (await admin('/api/admin/state')).body;
    const saved = await admin('/api/admin/history', 'POST', { expectedRevision: 0, expectedRosterRevision: state.rosterRevision });
    assert.equal(saved.status, 200);
    const currentState = (await admin('/api/admin/state')).body;
    const path = `/api/admin/history/${saved.body.id}`;
    const before = (await admin(path)).body.record;
    const raw = await local.db.prepare('SELECT * FROM vote_history WHERE id=?').bind(saved.body.id).first();
    const bucket = await local.mf.getR2Bucket('PHOTOS');
    const keys = (await bucket.list()).objects.map(object => object.key);
    assert.equal(keys.length, 1);
    const names = before.rows.map(row => ({ id: row.id, name: '가'.repeat(155) + row.number }));
    const payload = { expectedVersion: before.version, title: '101 wines renamed', names };
    assert(Buffer.byteLength(JSON.stringify(payload)) > 32768);
    const changed = await admin(path, 'PUT', payload);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.record.rows.length, 101);
    const snapshot = JSON.parse(raw.snapshot);
    const updated = JSON.parse((await local.db.prepare('SELECT snapshot FROM vote_history WHERE id=?').bind(saved.body.id).first()).snapshot);
    assert.deepEqual(updated.rows.map(({ name, ...row }) => row), snapshot.rows.map(({ name, ...row }) => row));
    assert.deepEqual(changed.body.record.rows.map(row => row.name), names.map(row => row.name));
    assert.deepEqual((await bucket.list()).objects.map(object => object.key), keys);
    assert.equal((await admin(changed.body.record.rows[0].photoUrl)).status, 200);
    assert.deepEqual((await admin('/api/admin/state')).body, currentState);
  } finally { await local.mf.dispose(); }
});
