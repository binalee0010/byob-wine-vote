import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp, client, TEST_PASSWORD, photo } from './harness.mjs';

const state = async admin => (await admin('/api/admin/state')).body;
const expected = current => ({ expectedRevision: current.activities[0].revision, expectedRosterRevision: current.rosterRevision });
const login = admin => admin('/api/admin/login', 'POST', { password: TEST_PASSWORD });

test('live results and full reset retain configuration and session behavior across restart without a separate archive', async () => {
  await mkdir('.wrangler', { recursive: true });
  const prefix = resolve('.wrangler/live-vote-');
  const persistenceRoot = await mkdtemp(prefix);
  const options = { persist: true, persistenceRoot };
  let local;
  try {
    local = await createApp(options);
    let admin = client(local.mf);
    const loggedIn = await login(admin);
    assert.equal(loggedIn.status, 200);
    const adminCookie = loggedIn.headers.get('set-cookie').split(';')[0];
    const participant = client(local.mf);
    const joined = await participant('/api/session', 'POST', { name: 'Synthetic participant' });
    const participantCookie = joined.headers.get('set-cookie').split(';')[0];
    assert.equal((await admin('/api/admin/settings', 'PATCH', { event: { title: 'Preserved gathering', memo: 'Private note' },
      activities: [{ id: 'byob', title: 'Preserved question', revision: 0, votingMethod: 'custom', rankPoints: [7, 2], resultVisibility: 'public' }]
    })).status, 200);
    const uploaded = await admin('/api/admin/candidates', 'POST', photo('Photographed wine'));
    const named = await admin('/api/admin/candidates', 'POST', { name: 'Named wine', requestId: 'named-wine', revision: 0 });
    assert.equal(uploaded.status, 200); assert.equal(named.status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    assert.equal((await participant('/api/activities/byob/answer', 'PUT', { ranking: [named.body.candidate.id, uploaded.body.candidate.id], revision: 0 })).status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'close', revision: 0 })).status, 200);
    const closed = await state(admin);
    assert.equal(closed.activities[0].resultsLocked, true);
    assert.deepEqual(closed.byobResults.map(row => row.points), [7, 2]);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 409);
    assert.equal((await client(local.mf)('/api/results/byob')).status, 200);
    assert.equal((await admin('/api/admin/history', 'POST', expected(closed))).status, 404);
    assert.equal(Object.hasOwn(closed, 'currentHistoryId'), false);
    const reset = data => admin('/api/admin/reset-all', 'POST', data);
    assert.equal((await reset(expected(closed))).status, 400);
    assert.equal((await reset({ ...expected(closed), confirm: 'reset-all', expectedRosterRevision: closed.rosterRevision + 1 })).body.code, 'roster_changed');
    assert.equal((await admin('/api/admin/reset-all', 'POST', { ...expected(closed), confirm: 'reset-all' }, { headers: { Origin: 'https://other.test' } })).status, 403);
    assert.deepEqual(await state(admin), closed);
    assert.deepEqual((await reset({ ...expected(closed), confirm: 'reset-all' })).body, { ok: true, revision: 1, cleanupPending: 0 });
    assert.equal((await reset({ ...expected(closed), confirm: 'reset-all' })).body.code, 'revision_changed');
    const after = await state(admin);
    assert.deepEqual(after.event, closed.event);
    assert.deepEqual(after.activities[0], { ...closed.activities[0], revision: 1, status: 'waiting', started: false, published: false, resultVisibility: 'private', resultsLocked: false });
    assert.deepEqual(after.participants, []); assert.deepEqual(after.candidates, []); assert.deepEqual(after.answers.byob, []);
    assert.equal((await participant('/api/bootstrap')).body.participant, null);
    assert.equal((await admin(uploaded.body.candidate.photoUrl)).status, 404);
    assert.equal((await (await local.mf.getR2Bucket('PHOTOS')).list()).objects.length, 0);
    await local.mf.dispose(); local = undefined;
    local = await createApp(options);
    admin = client(local.mf, adminCookie);
    assert.deepEqual(await state(admin), after);
    assert.equal((await client(local.mf, participantCookie)('/api/bootstrap')).body.participant, null);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM vote_history').first()).n, 0);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally {
    if (local) await local.mf.dispose();
    assert(persistenceRoot.startsWith(prefix));
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});

test('retired archive requests cannot race a reset or retain unused photos', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf); assert.equal((await login(admin)).status, 200);
    assert.equal((await admin('/api/admin/candidates', 'POST', photo('Reset photo'))).status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'close', revision: 0 })).status, 200);
    const current = await state(admin);
    const race = await Promise.all([
      admin('/api/admin/history', 'POST', expected(current)),
      admin('/api/admin/reset-all', 'POST', { ...expected(current), confirm: 'reset-all' })
    ]);
    assert.deepEqual(race.map(response => response.status), [404, 200]);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM vote_history').first()).n, 0);
    assert.equal((await (await local.mf.getR2Bucket('PHOTOS')).list()).objects.length, 0);
    const after = await state(admin); assert.equal(after.activities[0].revision, 1);
    assert.equal(Object.hasOwn(after, 'currentHistoryId'), false);
  } finally { await local.mf.dispose(); }
});
