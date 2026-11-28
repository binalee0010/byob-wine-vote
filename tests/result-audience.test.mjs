import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { createApp, client, TEST_PASSWORD, photo } from './harness.mjs';

const state = async admin => (await admin('/api/admin/state')).body;
const scope = (admin, resultVisibility, revision = 0) => admin('/api/admin/settings', 'PATCH', { activities: [{ id: 'byob', revision, resultVisibility }] });
const change = (admin, action, revision = 0) => admin('/api/admin/activities/byob/state', 'POST', { action, revision });

for (const legacy of [false, true]) test(`three result audiences enforce current-round entry, revocation, closed login and photo access (${legacy ? 'legacy' : 'fresh'})`, async () => {
  const local = await createApp({ legacy });
  try {
    const admin = client(local.mf), voter = client(local.mf), entrant = client(local.mf), anon = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    assert.equal((await state(admin)).activities[0].resultVisibility, 'private');
    const uploaded = await admin('/api/admin/candidates', 'POST', photo('Private wine')); assert.equal(uploaded.status, 200);
    const wine = uploaded.body.candidate;
    assert.equal((await anon(wine.photoUrl)).status, 403);
    assert.equal((await scope(admin, 'all')).status, 400);
    const voted = await voter('/api/session', 'POST', { name: 'Voter' });
    const entered = await entrant('/api/session', 'POST', { name: 'Entered without submitting' });
    assert.equal(voted.status, 200); assert.equal(entered.status, 200);
    await local.db.prepare("INSERT INTO participants VALUES('pre-registered','Never entered','never entered')").run();
    assert.equal((await scope(admin, 'participants')).status, 200);
    let bootstrap = await anon('/api/bootstrap');
    assert.equal(bootstrap.body.activities[0].resultVisibility, 'participants'); assert.equal(bootstrap.body.activities[0].published, false);
    for (const api of [anon, voter, entrant]) assert.equal((await api('/api/results/byob')).body.code, 'results_unpublished');
    assert.equal((await change(admin, 'open')).status, 200);
    assert.equal((await anon(wine.photoUrl)).status, 200);
    assert.equal((await voter('/api/activities/byob/answer', 'PUT', { ranking: [wine.id], revision: 0 })).status, 200);
    assert.equal((await entrant('/api/results/byob')).status, 403);
    assert.equal((await change(admin, 'close')).status, 200);
    bootstrap = await anon('/api/bootstrap');
    assert.equal(bootstrap.body.activities[0].published, true); assert.equal(bootstrap.body.activities[0].resultVisibility, 'participants');
    assert.equal(bootstrap.body.participant, null); assert.equal(Object.hasOwn(bootstrap.body, 'participants'), false);
    assert.equal((await anon('/api/results/byob')).body.code, 'participant_required');
    assert.equal((await anon(wine.photoUrl)).status, 403);
    const result = await entrant('/api/results/byob'); assert.equal(result.status, 200);
    assert.equal(result.body.participantId, entered.body.participant.id); assert.equal(result.body.rows[0].points, 1);
    assert.equal(JSON.stringify(result.body).includes(voted.body.participant.id), false);
    assert.equal(JSON.stringify(result.body).includes('Voter'), false);
    assert.equal((await voter('/api/results/byob')).status, 200);
    assert.equal((await entrant(wine.photoUrl)).status, 200);
    const rejoined = client(local.mf); assert.equal((await rejoined('/api/session', 'POST', { name: 'entered WITHOUT submitting' })).status, 200);
    assert.equal((await rejoined('/api/results/byob')).status, 200);
    const beforeParticipants = (await local.db.prepare('SELECT * FROM participants ORDER BY id').all()).results;
    for (const name of ['New after close', 'Never entered']) assert.equal((await anon('/api/session', 'POST', { name })).body.code, 'participant_not_entered');
    assert.deepEqual((await local.db.prepare('SELECT * FROM participants ORDER BY id').all()).results, beforeParticipants);
    assert.equal((await anon('/api/bootstrap')).body.participant, null);
    await local.db.prepare('UPDATE sessions SET expires_at=0 WHERE participant_id=?').bind(entered.body.participant.id).run();
    assert.equal((await entrant('/api/results/byob')).body.code, 'participant_required');
    assert.equal((await entrant(wine.photoUrl)).status, 403);
    assert.equal((await entrant('/api/session', 'POST', { name: 'Entered without submitting' })).status, 200);
    assert.equal((await scope(admin, 'public')).status, 200);
    assert.equal((await anon('/api/results/byob')).status, 200); assert.equal((await anon(wine.photoUrl)).status, 200);
    assert.equal(Object.hasOwn((await anon('/api/results/byob')).body, 'participantId'), false);
    assert.equal((await scope(admin, 'private')).status, 200);
    for (const api of [anon, entrant, voter]) { assert.equal((await api('/api/results/byob')).status, 403); assert.equal((await api(wine.photoUrl)).status, 403); }
    assert.equal((await admin(wine.photoUrl)).status, 200);
    const closed = await state(admin); assert.equal(closed.activities[0].resultsLocked, true);
    assert.equal((await change(admin, 'open')).status, 409);
    assert.equal((await scope(admin, 'participants')).status, 200);
    assert.deepEqual((await state(admin)).byobResults, closed.byobResults);
    // Reset revokes old sessions; the next round requires explicitly entering a name again.
    assert.equal((await admin('/api/admin/activities/byob/reset', 'POST', { confirm: 'reset', expectedRevision: 0 })).status, 200);
    assert.equal((await state(admin)).activities[0].resultVisibility, 'private');
    assert.equal((await scope(admin, 'participants', 1)).status, 200);
    assert.equal((await change(admin, 'open', 1)).status, 200);
    assert.equal((await entrant('/api/bootstrap')).status, 200);
    assert.equal((await entrant('/api/bootstrap')).body.participant, null);
    assert.equal((await entrant('/api/session', 'POST', { name: 'Entered without submitting' })).status, 200);
    assert.equal((await change(admin, 'close', 1)).status, 200);
    assert.equal((await entrant('/api/results/byob')).status, 200);
    assert.equal((await voter('/api/results/byob')).body.code, 'participant_required');
    assert.equal((await voter('/api/session', 'POST', { name: 'Voter' })).body.code, 'participant_not_entered');
    assert.equal((await voter('/api/bootstrap')).body.participant, null);
    assert.equal((await voter('/api/results/byob')).status, 403);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});

test('audience and session changes during result and photo reads fail closed', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf), person = client(local.mf);
    await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD });
    const wine = (await admin('/api/admin/candidates', 'POST', photo('Race wine'))).body.candidate;
    const joined = await person('/api/session', 'POST', { name: 'Race entrant' });
    const cookie = joined.headers.get('set-cookie').split(';')[0];
    await scope(admin, 'public'); await change(admin, 'open'); await change(admin, 'close');
    const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'], loader: { '.sql': 'text' } });
    const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    let intercepted = false;
    const DB = { prepare(sql) {
      const statement = local.db.prepare(sql);
      if (!sql.startsWith('SELECT c.*,coalesce(tally.score')) return statement;
      return { async all() { const rows = await statement.all(); intercepted = true; await scope(admin, 'private'); return rows; } };
    } };
    const response = await worker.fetch(new Request('https://vote.test/api/results/byob'), { DB });
    assert.equal(response.status, 403); assert.equal(intercepted, true);
    await scope(admin, 'participants'); intercepted = false;
    const RevokedDB = { prepare(sql) {
      const statement = local.db.prepare(sql);
      if (!sql.startsWith('SELECT c.*,coalesce(tally.score')) return statement;
      return { async all() { const rows = await statement.all(); intercepted = true; await local.db.prepare("DELETE FROM sessions WHERE role='participant'").run(); return rows; } };
    } };
    const revoked = await worker.fetch(new Request('https://vote.test/api/results/byob', { headers: { Cookie: cookie } }), { DB: RevokedDB });
    assert.equal(revoked.status, 403); assert.equal(intercepted, true);
    await scope(admin, 'public'); const bucket = await local.mf.getR2Bucket('PHOTOS');
    const hidden = await worker.fetch(new Request(`https://vote.test${wine.photoUrl}`), { DB: local.db, PHOTOS: { async get(key) { const object = await bucket.get(key); await scope(admin, 'private'); return object; } } });
    assert.equal(hidden.status, 403);
  } finally { await local.mf.dispose(); }
});

test('audience migrations retain proven non-voters and exclude old roster rows', async () => {
  const migration = await readFile(new URL('../migrations/0009_result_audience.sql', import.meta.url), 'utf8');
  assert.equal(migration, await readFile(new URL('../migrations-existing/0020_result_audience.sql', import.meta.url), 'utf8'));
  assert.equal(await readFile(new URL('../migrations/0008_event_memo.sql', import.meta.url), 'utf8'), await readFile(new URL('../migrations-existing/0019_event_memo.sql', import.meta.url), 'utf8'));
  for (const revision of [0, 2]) {
    const db = new DatabaseSync(':memory:');
    try {
      for (const file of ['0001_initial.sql', '0006_participant_entries.sql']) db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
      db.exec(`INSERT INTO participants VALUES('entrant','Existing nonvoter','existing nonvoter'); INSERT INTO participant_entries VALUES('entrant',0);
        INSERT INTO participants VALUES('old-entry','Earlier entrant','earlier entrant'); INSERT INTO participant_entries VALUES('old-entry',0);
        INSERT INTO participants VALUES('never','Preregistered','preregistered');
        INSERT INTO participants VALUES('recent','Current entrant','current entrant'); INSERT INTO participant_entries VALUES('recent',1793491200000);
        INSERT INTO candidates VALUES('wine',1,'Original wine','','','original-request');
        UPDATE activities SET revision=${revision},status='open',started_at='2026-11-01T00:00:00Z',publish_on_close=1;
        INSERT INTO answers VALUES('byob','entrant','{"ranking":["wine"]}','original-time'); UPDATE activities SET status='closed',published=1;`);
      // Only the recent entrant and voter are certain to belong to a later round.
      if (revision === 0) db.exec("DELETE FROM answers WHERE participant_id='entrant'");
      const tables = ['participants', 'answers', 'candidates', 'event'];
      const before = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
      const activity = db.prepare('SELECT * FROM activities').get();
      db.exec(migration);
      assert.deepEqual(Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])), before);
      assert.deepEqual({ ...db.prepare('SELECT * FROM activities').get() }, { ...activity, result_visibility: 'public' });
      assert.deepEqual(db.prepare('SELECT participant_id FROM participant_round_entries ORDER BY participant_id').all().map(row => row.participant_id), revision === 0 ? ['entrant', 'old-entry', 'recent'] : ['entrant', 'recent']);
      assert.equal(db.prepare("SELECT count(*) AS n FROM participant_round_entries WHERE participant_id='never'").get().n, 0);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  }
});
