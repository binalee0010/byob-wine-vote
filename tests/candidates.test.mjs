import test from 'node:test';
import assert from 'node:assert/strict';
import { client, createApp, photo, PNG, TEST_PASSWORD } from './harness.mjs';

test('candidate images validate bytes, deduplicate concurrent retries and lock after voting starts', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf), anon = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const bad = photo('Invalid image');
    bad.set('file', new File(['<svg></svg>'], 'invalid.png', { type: 'image/png' }));
    assert.equal((await admin('/api/admin/candidates', 'POST', bad)).status, 415);
    const large = photo('Oversized image');
    large.set('file', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }));
    assert.equal((await admin('/api/admin/candidates', 'POST', large)).status, 413);
    const requestId = crypto.randomUUID();
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => admin('/api/admin/candidates', 'POST', photo('Synthetic photo', requestId))));
    assert(duplicates.every(response => response.status === 200));
    assert.equal(new Set(duplicates.map(response => response.body.candidate.id)).size, 1);
    const candidate = duplicates[0].body.candidate;
    const photos = await local.mf.getR2Bucket('PHOTOS');
    assert.equal((await photos.list()).objects.length, 1);
    assert.equal((await anon(candidate.photoUrl)).status, 403);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    const response = await local.mf.dispatchFetch(`https://vote.test${candidate.photoUrl}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
    assert.equal((await admin('/api/admin/candidates', 'POST', photo('Locked'))).status, 409);
    assert.equal((await admin(`/api/admin/candidates/${candidate.id}`, 'DELETE', { revision: 0 })).status, 409);
    await assert.rejects(local.db.prepare("UPDATE candidates SET name='Locked'").run(), /candidates_locked/);
    assert.equal((await photos.list()).objects.length, 1);
  } finally { await local.mf.dispose(); }
});

for (const legacy of [false, true]) test(`unnamed photos use their assigned numbers and retain identity across retries (${legacy ? 'legacy' : 'fresh'})`, async () => {
  const local = await createApp({ legacy });
  try {
    const admin = client(local.mf); assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const unnamed = requestId => { const form = photo('unused', requestId); form.delete('name'); form.set('revision', '0'); return form; };
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const added = await Promise.all(ids.map(id => admin('/api/admin/candidates', 'POST', unnamed(id))));
    assert.ok(added.every(response => response.status === 200)); assert.equal(new Set(added.map(response => response.body.candidate.id)).size, 2);
    assert.deepEqual(added.map(response => response.body.candidate.number).sort(), [1, 2]);
    for (const { body } of added) assert.equal(body.candidate.name, '와인 ' + String(body.candidate.number).padStart(2, '0'));
    const retried = await admin('/api/admin/candidates', 'POST', unnamed(ids[0])); assert.equal(retried.status, 200); assert.deepEqual(retried.body.candidate, added[0].body.candidate);
    const explicit = await admin('/api/admin/candidates', 'POST', photo('직접 정한 와인')); assert.equal(explicit.status, 200); assert.equal(explicit.body.candidate.name, '직접 정한 와인');
    assert.equal((await admin('/api/admin/candidates', 'POST', { revision: 0, requestId: crypto.randomUUID() })).status, 400);
    assert.equal((await admin('/api/admin/state')).body.candidates.length, 3); assert.equal((await (await local.mf.getR2Bucket('PHOTOS')).list()).objects.length, 3);
  } finally { await local.mf.dispose(); }
});

test('full ranking awards eight through one and produces competition ties from complete ballots', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf), first = client(local.mf), second = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const ranking = [];
    for (let i = 1; i <= 8; i++) {
      const added = await admin('/api/admin/candidates', 'POST', { name: `Synthetic wine ${i}`, requestId: crypto.randomUUID(), revision: 0 });
      assert.equal(added.status, 200);
      ranking.push(added.body.candidate.id);
    }
    for (const [i, request] of [first, second].entries()) assert.equal((await request('/api/session', 'POST', { name: `Synthetic voter ${i}` })).status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    const vote = (request, ids) => request('/api/activities/byob/answer', 'PUT', { ranking: ids, revision: 0 });
    assert.equal((await vote(first, ranking.slice(1))).body.code, 'invalid_ranking');
    assert.equal((await vote(first, ranking)).status, 200);
    assert.deepEqual((await admin('/api/admin/state')).body.byobResults.map(row => row.points), [8, 7, 6, 5, 4, 3, 2, 1]);
    assert.equal((await vote(second, ranking.toReversed())).status, 200);
    const tied = (await admin('/api/admin/state')).body.byobResults;
    assert.deepEqual(tied.map(row => row.points), Array(8).fill(9));
    assert.deepEqual(tied.map(row => row.rank), Array(8).fill(1));
    assert.equal((await vote(second, ranking)).status, 200);
    assert.equal((await vote(first, [ranking[0], ranking[2], ranking[1], ...ranking.slice(3)])).status, 200);
    const state = (await admin('/api/admin/state')).body;
    assert.equal(state.answers.byob.length, 2);
    assert.deepEqual(state.byobResults.map(row => row.points), [16, 13, 13, 10, 8, 6, 4, 2]);
    assert.deepEqual(state.byobResults.map(row => row.rank), [1, 2, 2, 4, 5, 6, 7, 8]);
  } finally { await local.mf.dispose(); }
});
