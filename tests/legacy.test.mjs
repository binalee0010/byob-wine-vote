import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp, client, TEST_PASSWORD } from './harness.mjs';
import { hashPassword } from '../scripts/password.mjs';

const bindings = { ADMIN_SESSION_COOKIE: '__Host-previous_admin', PARTICIPANT_SESSION_COOKIE: '__Host-previous_participant' };
const digest = value => createHash('sha256').update(value).digest('hex');
const dump = async db => {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf%' ORDER BY name").all()).results;
  const result = {};
  for (const { name } of tables) result[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
  return result;
};

test('existing schema and configured cookies retain credentials, participants, ballots and history across code replacement', async () => {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const local = await createApp({ legacy: true, passwordHash, bindings, publicOrigin: 'https://canonical.example.com' });
  try {
    const adminToken = '1'.repeat(64), participantToken = '2'.repeat(64), version = 'existing-credential-version';
    const fingerprint = digest(passwordHash), now = Date.now();
    await local.db.batch([
      local.db.prepare('INSERT INTO admin_credentials VALUES(1,?,?,?)').bind(passwordHash, fingerprint, version),
      local.db.prepare('INSERT INTO admin_bootstrap_history VALUES(?)').bind(fingerprint),
      local.db.prepare("INSERT INTO participants VALUES('existing-person','Existing person','existing person')"),
      local.db.prepare("INSERT INTO sessions VALUES(?,'admin',NULL,?,?)").bind(digest(adminToken), now + 3600000, version),
      local.db.prepare("INSERT INTO sessions VALUES(?,'participant','existing-person',?,NULL)").bind(digest(participantToken), now + 3600000),
      local.db.prepare("INSERT INTO candidates(id,number,name,object_key,content_type,request_id) VALUES('existing-wine',1,'Existing wine','','','existing-upload')"),
      local.db.prepare("UPDATE activities SET voting_method='full',status='open',started_at='2026-01-01T12:00:00Z' WHERE id='byob'"),
      local.db.prepare("INSERT INTO answers VALUES('byob','existing-person',?,?)").bind(JSON.stringify({ ranking: ['existing-wine'] }), '2026-01-01T12:01:00Z'),
      local.db.prepare("UPDATE activities SET status='closed' WHERE id='byob'"),
      local.db.prepare("INSERT INTO vote_history VALUES('existing-history',0,'2026-01-01T12:02:00Z',?)").bind(JSON.stringify({ title: 'Existing event', activityTitle: 'Existing vote', startedAt: '2026-01-01T12:00:00Z', votingMethod: 'full', rankPoints: [3, 1], ballotCount: 1, rows: [{ id: 'existing-wine', number: 1, name: 'Existing wine', object_key: '', content_type: '', score: 1 }] }))
    ]);
    const before = await dump(local.db);
    const schema = (await local.db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).results;
    const adminCookie = `${bindings.ADMIN_SESSION_COOKIE}=${adminToken}`;
    const participantCookie = `${bindings.PARTICIPANT_SESSION_COOKIE}=${participantToken}`;
    const admin = client(local.mf, adminCookie), person = client(local.mf, participantCookie);
    const state = await admin('/api/admin/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.participantUrl, 'https://canonical.example.com/');
    const alias = await local.mf.dispatchFetch('https://old.example.com/api/admin/state', { headers: { Cookie: adminCookie } });
    assert.equal(alias.status, 200);
    assert.equal((await alias.json()).participantUrl, 'https://canonical.example.com/');
    assert.deepEqual(state.body.activities.map(row => row.id), ['byob']);
    assert.equal(state.body.currentHistoryId, 'existing-history');
    assert.equal(state.body.byobResults[0].points, 1);
    assert.equal((await person('/api/bootstrap')).body.participant.id, 'existing-person');
    assert.equal((await person('/api/bootstrap')).body.participant.submitted.byob, true);
    assert.equal((await person('/api/activities/byob')).status, 403);
    assert.equal((await admin('/api/admin/history/existing-history')).body.record.rows[0].name, 'Existing wine');
    assert.deepEqual(await dump(local.db), before);
    assert.deepEqual((await local.db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).results, schema);
    assert.equal((await client(local.mf, `__Host-byob_admin=${adminToken}`)('/api/admin/state')).status, 401);
    const loggedOut = await admin('/api/admin/session', 'DELETE');
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers.get('set-cookie'), /^__Host-previous_admin=;.*Max-Age=0/);
    assert.equal((await client(local.mf, adminCookie)('/api/admin/state')).status, 401);
    assert.equal((await person('/api/bootstrap')).body.participant.id, 'existing-person');
    const loggedIn = await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD });
    assert.equal(loggedIn.status, 200);
    assert.match(loggedIn.headers.get('set-cookie'), /^__Host-previous_admin=/);
    assert.deepEqual(await local.db.prepare('SELECT * FROM admin_credentials').first(), before.admin_credentials[0]);
    assert.deepEqual((await local.db.prepare('SELECT * FROM answers').all()).results, before.answers);
    assert.deepEqual((await local.db.prepare('SELECT * FROM vote_history').all()).results, before.vote_history);
    assert.equal((await admin('/api/admin/settings', 'PATCH', { event: { title: 'New event title' } })).status, 200);
    const event = await local.db.prepare('SELECT * FROM event').first();
    assert.equal(event.starts_at, before.event[0].starts_at);
    assert.equal(event.timezone, before.event[0].timezone);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});

test('legacy dormant activities permit full reset while active other activity data blocks roster destruction', async () => {
  const local = await createApp({ legacy: true });
  try {
    const admin = client(local.mf), person = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const join = await person('/api/session', 'POST', { name: 'Shared person' });
    const id = join.body.participant.id;
    assert.equal((await admin('/api/admin/candidates', 'POST', { name: 'Current wine', requestId: 'reset-wine', revision: 0 })).status, 200);
    const state = async () => (await admin('/api/admin/state')).body;
    const reset = current => admin('/api/admin/reset-all', 'POST', { confirm: 'reset-all', expectedRevision: current.activities[0].revision, expectedRosterRevision: current.rosterRevision });
    await local.db.prepare("UPDATE activities SET status='open',started_at='2026-01-01T00:00:00Z',actual=100 WHERE id='price'").run();
    await local.db.prepare("INSERT INTO answers VALUES('price',?,?,?)").bind(id, '{"price":100}', '2026-01-01T00:00:00Z').run();
    const before = await dump(local.db);
    const current = await state();
    const blockedReset = await reset(current);
    assert.equal(blockedReset.status,409);assert.equal(blockedReset.body.code,'shared_activity_data');
    for (const response of [
      await admin(`/api/admin/participants/${id}`, 'DELETE', { confirm: 'delete' }),
      await admin('/api/admin/participants', 'DELETE', { confirm: 'delete', expectedRosterRevision: current.rosterRevision })
    ]) { assert.equal(response.status, 410); assert.equal(response.body.code, 'roster_read_only'); }
    assert.deepEqual(await dump(local.db), before);
    assert.equal((await admin('/api/admin/reset', 'POST', { confirm: 'reset', expectedRevisions: { byob: 0 } })).status, 200);
    assert.deepEqual((await local.db.prepare("SELECT * FROM answers WHERE activity_id='price'").all()).results, before.answers);
    await local.db.prepare("UPDATE activities SET revision=revision+1,status='waiting',started_at=NULL WHERE id='price'").run();
    await local.db.prepare("INSERT INTO grades VALUES(?,'preserved grade','private note','{}')").bind(id).run();
    const graded = await dump(local.db);
    assert.equal((await reset(await state())).body.code, 'shared_activity_data');
    assert.deepEqual(await dump(local.db), graded);
    await local.db.prepare('DELETE FROM grades').run();
    const dormant = (await local.db.prepare("SELECT * FROM activities WHERE id<>'byob' ORDER BY id").all()).results;
    assert.equal((await reset(await state())).status, 200);
    assert.deepEqual((await state()).participants, []);
    assert.deepEqual((await state()).candidates, []);
    assert.deepEqual((await local.db.prepare("SELECT * FROM activities WHERE id<>'byob' ORDER BY id").all()).results, dormant);
    assert.equal((await person('/api/session', 'POST', {name:'Dormant individual'})).status,200);
    assert.equal((await admin('/api/admin/participants', 'POST', { names: ['Blocked roster'] })).status,410);
    assert.equal((await reset(await state())).status,200);
    assert.deepEqual((await state()).participants, []);
  } finally { await local.mf.dispose(); }
});

test('participant share address is a canonical root and rejects unsafe configured origins', async () => {
  for (const publicOrigin of [undefined, 'https://canonical.example.com/admin?next=wrong#fragment', 'javascript:alert(1)', 'https://user:secret@canonical.example.com/']) {
    const local = await createApp({ publicOrigin });
    try {
      const admin = client(local.mf);
      assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
      const response = await admin('/api/admin/state');
      if (publicOrigin?.startsWith('javascript:') || publicOrigin?.includes('user:secret')) {
        assert.equal(response.status, 503);
        assert.equal(response.body.code, 'origin_unconfigured');
      } else {
        assert.equal(response.status, 200);
        assert.equal(response.body.participantUrl, publicOrigin ? 'https://canonical.example.com/' : 'https://vote.test/');
      }
    } finally { await local.mf.dispose(); }
  }
});
