import test from 'node:test';
import assert from 'node:assert/strict';
import { client, createApp, photo, PNG, TEST_PASSWORD } from './harness.mjs';

const state = async admin => (await admin('/api/admin/state')).body;
const reset = (admin, revision, aggregate = false) => admin(aggregate ? '/api/admin/reset' : '/api/admin/activities/byob/reset', 'POST',
  { confirm: 'reset', ...(aggregate ? { expectedRevisions: { byob: revision } } : { expectedRevision: revision }) });
const dump = async db => Object.fromEntries(await Promise.all(['event', 'activities', 'participants', 'sessions', 'participant_entries', 'participant_round_entries', 'answers', 'candidates', 'vote_history']
  .map(async table => [table, (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));

for (const legacy of [false, true]) test(`record reset clears submitted and unsubmitted entry, revokes sessions, preserves identities, photos, settings and history (${legacy ? 'legacy aggregate' : 'fresh activity'})`, async () => {
  const local = await createApp({ legacy });
  try {
    const admin = client(local.mf), voter = client(local.mf), duplicate = client(local.mf), idle = client(local.mf), anon = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const joined = await voter('/api/session', 'POST', { name: 'Submitted person' });
    assert.equal((await duplicate('/api/session', 'POST', { name: 'submitted person' })).body.participant.id, joined.body.participant.id);
    assert.equal((await idle('/api/session', 'POST', { name: 'Unsubmitted person' })).status, 200);
    const uploaded = await admin('/api/admin/candidates', 'POST', photo('Preserved wine')); assert.equal(uploaded.status, 200);
    const wine = uploaded.body.candidate;
    assert.equal((await admin('/api/admin/settings', 'PATCH', { event: { title: 'Preserved poll', memo: 'Preserved memo' },
      activities: [{ id: 'byob', revision: 0, title: 'Preserved question', votingMethod: 'custom', rankPoints: [7], resultVisibility: 'participants' }] })).status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    assert.equal((await voter('/api/activities/byob/answer', 'PUT', { ranking: [wine.id], revision: 0 })).status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'close', revision: 0 })).status, 200);
    const archivedWine = await local.db.prepare('SELECT * FROM candidates WHERE id=?').bind(wine.id).first();
    await local.db.prepare("INSERT INTO vote_history(id,revision,saved_at,snapshot) VALUES('preserved-history',0,'2026-11-01',?)")
      .bind(JSON.stringify({ title: 'Archived poll', rows: [{ ...archivedWine, points: 7 }] })).run();
    const bucket = await local.mf.getR2Bucket('PHOTOS');
    const before = await dump(local.db), current = await state(admin), photos = (await bucket.list()).objects.map(row => row.key);
    assert.equal(current.participants.length, 2); assert.equal(current.submittedCount, 1);
    assert.equal((await reset(anon, 0, legacy)).status, 401);
    assert.equal((await reset(admin, 1, legacy)).body.code, 'revision_changed');
    assert.deepEqual(await dump(local.db), before);
    assert.equal((await reset(admin, 0, legacy)).status, 200);
    const cleared = await state(admin), stored = await dump(local.db);
    assert.deepEqual(cleared.participants, []); assert.equal(cleared.submittedCount, 0); assert.deepEqual(cleared.answers.byob, []);
    assert.deepEqual(cleared.candidates, current.candidates); assert.deepEqual(cleared.event, current.event); assert.equal(cleared.participantUrl, current.participantUrl);
    assert.deepEqual(cleared.activities[0], { ...current.activities[0], revision: 1, status: 'waiting', started: false, published: false, resultVisibility: 'private', resultsLocked: false });
    assert.deepEqual(stored.participants, before.participants); assert.deepEqual(stored.candidates, before.candidates); assert.deepEqual(stored.vote_history, before.vote_history);
    assert.deepEqual(stored.participant_entries, []); assert.deepEqual(stored.participant_round_entries, []); assert.deepEqual(stored.answers, []);
    assert.deepEqual(stored.sessions, before.sessions.filter(row => row.role === 'admin'));
    assert.deepEqual((await bucket.list()).objects.map(row => row.key), photos);
    for (const key of photos) assert.deepEqual(Buffer.from(await (await bucket.get(key)).arrayBuffer()), PNG);
    for (const person of [voter, duplicate, idle]) assert.equal((await person('/api/bootstrap')).body.participant, null);
    assert.deepEqual((await state(admin)).participants, []);
    assert.equal((await voter('/api/activities/byob/answer', 'PUT', { ranking: [wine.id], revision: 0 })).status, 401);
    await local.db.prepare("CREATE TRIGGER synthetic_rejoin_failure BEFORE INSERT ON sessions WHEN NEW.role='participant' BEGIN SELECT RAISE(ABORT,'synthetic_rejoin_failure'); END").run();
    const beforeFailedRejoin = await dump(local.db);
    assert.equal((await voter('/api/session', 'POST', { name: 'Submitted person' })).status, 500);
    assert.deepEqual(await dump(local.db), beforeFailedRejoin);
    await local.db.prepare('DROP TRIGGER synthetic_rejoin_failure').run();
    const [rejoined, rejoinedDuplicate] = await Promise.all([
      voter('/api/session', 'POST', { name: 'SUBMITTED PERSON' }), duplicate('/api/session', 'POST', { name: 'submitted person' })
    ]);
    assert.equal(rejoined.status, 200); assert.deepEqual(rejoined.body.participant, joined.body.participant);
    assert.equal(rejoinedDuplicate.status, 200); assert.deepEqual(rejoinedDuplicate.body.participant, joined.body.participant);
    assert.equal((await state(admin)).rosterRevision, cleared.rosterRevision + 1);
    const afterRejoin = await dump(local.db);
    const staleFullReset = await admin('/api/admin/reset-all', 'POST', { confirm: 'reset-all', expectedRevision: 1, expectedRosterRevision: cleared.rosterRevision });
    assert.equal(staleFullReset.status, 409); assert.equal(staleFullReset.body.code, 'roster_changed');
    assert.deepEqual(await dump(local.db), afterRejoin);
    assert.deepEqual((await bucket.list()).objects.map(row => row.key), photos);
    for (const aggregate of [false, true]) assert.equal((await reset(admin, 0, aggregate)).body.code, 'revision_changed');
    assert.deepEqual(await dump(local.db), afterRejoin);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 1 })).status, 200);
    assert.equal((await voter('/api/activities/byob/answer', 'PUT', { ranking: [wine.id], revision: 0 })).body.code, 'revision_changed');
    assert.equal((await voter('/api/activities/byob/answer', 'PUT', { ranking: [wine.id], revision: 1 })).status, 200);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});

test('record reset rolls back entries, sessions and ballots when its final revision update fails', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf), person = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    assert.equal((await person('/api/session', 'POST', { name: 'Preserved on failure' })).status, 200);
    const wine = (await admin('/api/admin/candidates', 'POST', { name: 'Wine', requestId: 'rollback-wine', revision: 0 })).body.candidate;
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    assert.equal((await person('/api/activities/byob/answer', 'PUT', { ranking: [wine.id], revision: 0 })).status, 200);
    await local.db.prepare("CREATE TRIGGER synthetic_reset_failure BEFORE UPDATE OF revision ON activities BEGIN SELECT RAISE(ABORT,'synthetic_reset_failure'); END").run();
    const before = await dump(local.db);
    assert.equal((await reset(admin, 0)).status, 500);
    assert.deepEqual(await dump(local.db), before);
    await local.db.prepare('DROP TRIGGER synthetic_reset_failure').run();
    const raced = await Promise.all([reset(admin, 0), reset(admin, 0, true)]);
    assert.deepEqual(raced.map(row => row.status).sort(), [200, 409]);
    assert.equal((await state(admin)).activities[0].revision, 1); assert.deepEqual((await state(admin)).participants, []);
  } finally { await local.mf.dispose(); }
});
