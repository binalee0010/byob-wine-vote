import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { client, createApp, TEST_PASSWORD, photo, PNG } from './harness.mjs';
import { hashPassword } from '../scripts/password.mjs';

const bindings = { SUPERADMIN_EMAIL: 'superadmin@example.test' };
const digest = value => createHash('sha256').update(value).digest('hex');
const memberPassword = 'Synthetic-member-password!';
const expected = state => ({ expectedRevision: state.activities[0].revision, expectedRosterRevision: state.rosterRevision });
function memberClient(mf) {
  const request = client(mf); let csrf = '';
  return async (path, method = 'GET', data, options = {}) => {
    const response = await request(path, method, data, { ...options, headers: { 'x-member-csrf': csrf, ...options.headers } });
    if (response.body?.csrfToken) csrf = response.body.csrfToken;
    return response;
  };
}
async function loginOwner(owner) {
  const response = await owner('/api/members/login', 'POST', { email: bindings.SUPERADMIN_EMAIL, password: TEST_PASSWORD });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response;
}
async function signup(member, email) {
  const response = await member('/api/members/signup', 'POST', { email, password: memberPassword });
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.member;
}
async function state(member) {
  const response = await member('/api/admin/state');
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function approve(owner, member, account) {
  const response = await owner(`/api/members/requests/${account.id}/approve`, 'POST', {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await member('/api/members/session')).status, 200);
}

test('approved members isolate ballots, photos, admin routes, archives, reset and cookies in one D1 database', async () => {
  const local = await createApp({ bindings, publicOrigin: 'https://canonical.example.test' });
  try {
    const owner = memberClient(local.mf), a = memberClient(local.mf), b = memberClient(local.mf), rejected = memberClient(local.mf);
    const anonymous = client(local.mf), participant = client(local.mf);
    assert.equal((await anonymous('/api/admin/login', 'POST', { password: TEST_PASSWORD })).body.code, 'member_login_required');
    await loginOwner(owner);
    const aa = await signup(a, 'member-a@example.test'), bb = await signup(b, 'member-b@example.test'), rr = await signup(rejected, 'rejected@example.test');
    const pathA = `/v/${aa.workspaceSlug}/api`, pathB = `/v/${bb.workspaceSlug}/api`;
    assert.equal((await a('/api/admin/state')).status, 401);
    assert.equal((await a('/api/members/requests')).status, 403);
    assert.equal((await a(pathA + '/bootstrap')).status, 404);
    assert.equal((await local.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'm_%_event'").first()).n, 0);
    assert.equal((await owner(`/api/members/requests/${rr.id}/reject`, 'POST', {})).status, 200);
    assert.equal((await rejected('/api/admin/state')).status, 401);
    assert.equal((await anonymous(`/v/${rr.workspaceSlug}/api/bootstrap`)).status, 404);
    await approve(owner, a, aa); await approve(owner, b, bb);
    const sessionA = await a('/api/members/session');
    const loginB = await b('/api/members/login', 'POST', { email: 'member-b@example.test', password: memberPassword });
    const cookieB = loginB.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const staleATab = client(local.mf, cookieB);
    for (const [path, method] of [['/settings', 'PATCH'], ['/reset-all', 'POST'], ['/history', 'POST'], ['/candidates', 'POST'], ['/candidates/cleanup', 'POST'], ['/sessions', 'DELETE'], ['/session', 'DELETE'], ['/password', 'POST']]) {
      const response = await staleATab('/api/admin' + path, method, {}, { headers: { 'x-member-csrf': sessionA.body.csrfToken } });
      assert.equal(response.status, 403, `${path}: ${JSON.stringify(response.body)}`);
    }
    assert.equal((await staleATab('/api/admin/candidates', 'POST', photo('Stale upload'), { headers: { 'x-member-csrf': sessionA.body.csrfToken } })).status, 403);
    assert.equal((await staleATab('/api/admin/candidates', 'POST', {}, { headers: { 'x-member-csrf': '' } })).status, 403);
    assert.equal((await state(a)).participantUrl, `https://canonical.example.test/v/${aa.workspaceSlug}`);
    assert.equal((await state(b)).candidates.length, 0);
    assert.equal((await state(owner)).participantUrl, 'https://canonical.example.test/v/owner');
    const pa = await participant(pathA + '/session', 'POST', { name: 'Same name' });
    const pb = await participant(pathB + '/session', 'POST', { name: 'Same name' });
    assert.equal(pa.status, 200); assert.equal(pb.status, 200);
    assert.notEqual(pa.body.participant.id, pb.body.participant.id);
    assert.notEqual(pa.headers.get('set-cookie').split('=')[0], pb.headers.get('set-cookie').split('=')[0]);
    assert.equal((await participant(pathA + '/bootstrap')).body.participant.id, pa.body.participant.id);
    assert.equal((await participant(pathB + '/bootstrap')).body.participant.id, pb.body.participant.id);
    assert.equal((await participant('/api/bootstrap')).body.participant, null);
    const ca = await a('/api/admin/candidates', 'POST', photo('A private wine'));
    const cb = await b('/api/admin/candidates', 'POST', photo('B private wine'));
    assert.equal(ca.status, 200, JSON.stringify(ca.body)); assert.equal(cb.status, 200, JSON.stringify(cb.body));
    assert.equal(ca.body.candidate.photoUrl, `${pathA}/photos/${ca.body.candidate.id}`);
    assert.equal(cb.body.candidate.photoUrl, `${pathB}/photos/${cb.body.candidate.id}`);
    for (const adminPath of ['/admin/state', '/admin/reset-all', '/admin/history', '/admin/participants', '/admin/candidates', '/admin/sessions', '/admin/password']) {
      const method = adminPath === '/admin/state' || adminPath === '/admin/history' ? 'GET' : 'POST';
      assert.equal((await a(pathB + adminPath, method, method === 'GET' ? undefined : {})).status, 403);
    }
    assert.equal((await a(cb.body.candidate.photoUrl)).status, 403);
    assert.equal((await anonymous(ca.body.candidate.photoUrl)).status, 403);
    assert.equal((await a(ca.body.candidate.photoUrl)).status, 200);
    assert.equal((await b('/api/admin/history/not-owned')).status, 404);
    assert.equal((await a('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    assert.equal((await b('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    const answer = (path, ranking, expectedParticipantId) => participant(path + '/activities/byob/answer', 'PUT', { ranking, revision: 0, expectedParticipantId });
    assert.equal((await answer(pathB, [ca.body.candidate.id], pb.body.participant.id)).status, 400);
    assert.equal((await answer(pathA, [ca.body.candidate.id], pb.body.participant.id)).body.code, 'participant_changed');
    assert.equal((await answer(pathA, [ca.body.candidate.id], pa.body.participant.id)).status, 200);
    assert.equal((await answer(pathB, [cb.body.candidate.id], pb.body.participant.id)).status, 200);
    assert.deepEqual((await state(a)).answers.byob[0].ranking, [ca.body.candidate.id]);
    assert.deepEqual((await state(b)).answers.byob[0].ranking, [cb.body.candidate.id]);
    assert.equal((await anonymous(pathA + `/photos/${cb.body.candidate.id}`)).status, 404);
    assert.equal((await anonymous(cb.body.candidate.photoUrl)).status, 200);
    assert.equal((await a('/api/admin/activities/byob/state', 'POST', { action: 'close', revision: 0 })).status, 200);
    const saved = await a('/api/admin/history', 'POST', expected(await state(a)));
    assert.equal(saved.status, 200);
    const archive = await a('/api/admin/history/' + saved.body.id);
    const archivedPhoto = archive.body.record.rows[0].photoUrl;
    assert.equal(archivedPhoto, `${pathA}/admin/history/${saved.body.id}/photos/${ca.body.candidate.id}`);
    assert.equal((await a(archivedPhoto)).status, 200);
    assert.equal((await b('/api/admin/history/' + saved.body.id)).status, 404);
    assert.equal((await b(archivedPhoto)).status, 403);
    const beforeB = await state(b), beforeOwner = await state(owner);
    assert.equal((await a('/api/admin/reset-all', 'POST', { ...expected(await state(a)), confirm: 'reset-all' })).status, 200);
    assert.equal((await state(a)).candidates.length, 0);
    assert.equal((await state(a)).participants.length, 0);
    assert.equal((await a(archivedPhoto)).status, 200);
    assert.equal((await participant(pathA + '/bootstrap')).body.participant, null);
    assert.equal((await participant(pathB + '/bootstrap')).body.participant.id, pb.body.participant.id);
    assert.deepEqual(await state(b), beforeB); assert.deepEqual(await state(owner), beforeOwner);
    const nsA = 'm_' + aa.id, nsB = 'm_' + bb.id;
    const keyB = (await local.db.prepare(`SELECT object_key FROM ${nsB}_candidates`).first()).object_key;
    assert.match(keyB, new RegExp(`^members/${nsB}/candidates/`));
    await local.db.prepare(`INSERT INTO ${nsA}_candidate_photo_cleanup VALUES(?)`).bind(keyB).run();
    const cleanup = await a('/api/admin/candidates/cleanup', 'POST', {});
    assert.equal(cleanup.status, 200); assert.equal(cleanup.body.cleanupPending, 1);
    assert(await (await local.mf.getR2Bucket('PHOTOS')).get(keyB));
    const secondA = memberClient(local.mf);
    assert.equal((await secondA('/api/members/login', 'POST', { email: 'member-a@example.test', password: memberPassword })).status, 200);
    assert.equal((await state(secondA)).candidates.length, 0);
    const otherSessions = async () => ({
      members: (await local.db.prepare('SELECT * FROM member_sessions WHERE member_id<>? ORDER BY token_hash').bind(aa.id).all()).results,
      b: (await local.db.prepare(`SELECT * FROM ${nsB}_sessions ORDER BY token_hash`).all()).results,
      owner: (await local.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all()).results
    });
    const beforeOtherSessions = await otherSessions();
    const ended = await a('/api/admin/sessions', 'DELETE');
    assert.equal(ended.status, 200);
    assert(ended.headers.getSetCookie().some(value => value.startsWith('__Host-byob_member=;') && value.includes('Max-Age=0')));
    assert.equal((await a('/api/admin/state')).status, 401);
    assert.equal((await secondA('/api/admin/state')).status, 401);
    assert.equal((await a('/api/members/session')).body.authenticated, false);
    assert.equal((await secondA('/api/members/session')).body.authenticated, false);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM member_sessions WHERE member_id=?').bind(aa.id).first()).n, 0);
    assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM ${nsA}_sessions WHERE role='admin'`).first()).n, 0);
    assert.deepEqual(await otherSessions(), beforeOtherSessions);
    assert.equal((await state(b)).candidates[0].name, 'B private wine');
    assert.deepEqual(await state(owner), beforeOwner);
    assert.equal((await participant(pathB + '/bootstrap')).body.participant.id, pb.body.participant.id);
    assert.equal((await a('/api/members/login', 'POST', { email: 'member-a@example.test', password: memberPassword })).status, 200);
    assert.equal((await state(a)).candidates.length, 0);
    const racing = memberClient(local.mf), raceAccount = await signup(racing, 'first-access-race@example.test');
    // Simulate approval committed before provisioning, then concurrent participant entry.
    await local.db.prepare("UPDATE members SET status='approved' WHERE id=?").bind(raceAccount.id).run();
    const firstEntries = await Promise.all(Array.from({ length: 4 }, () => anonymous(`/v/${raceAccount.workspaceSlug}/api/bootstrap`)));
    assert(firstEntries.every(response => response.status === 200), JSON.stringify(firstEntries));
    assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM m_${raceAccount.id}_event`).first()).n, 1);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});

test('legacy owner tables, existing participant cookie, credentials, archives and photo keys survive member workspaces', async () => {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const legacyCookies = { ADMIN_SESSION_COOKIE: '__Host-existing_admin', PARTICIPANT_SESSION_COOKIE: '__Host-existing_participant' };
  const local = await createApp({ legacy: true, passwordHash, bindings: { ...bindings, ...legacyCookies } });
  try {
    // Apply only the additive membership migration to the prior production-style schema.
    const migration = await readFile(new URL('../migrations/0002_members.sql', import.meta.url), 'utf8');
    for (const sql of migration.split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean)) await local.db.prepare(sql).run();
    const version = 'preserved-existing-version', oldAdmin = '1'.repeat(64), oldPerson = '2'.repeat(64);
    const snapshot = { title: 'Preserved event', activityTitle: 'Preserved vote', startedAt: '2026-01-01', votingMethod: 'full', rankPoints: [3, 1], ballotCount: 1,
      rows: [{ id: 'old-wine', number: 1, name: 'Preserved wine', object_key: 'candidates/old-photo', content_type: 'image/png', score: 1 }] };
    await local.db.batch([
      local.db.prepare('INSERT INTO admin_credentials VALUES(1,?,?,?)').bind(passwordHash, digest(passwordHash), version),
      local.db.prepare('INSERT INTO admin_bootstrap_history VALUES(?)').bind(digest(passwordHash)),
      local.db.prepare("INSERT INTO participants VALUES('old-person','Preserved participant','preserved participant')"),
      local.db.prepare("INSERT INTO sessions VALUES(?,'admin',NULL,?,?)").bind(digest(oldAdmin), Date.now() + 3600000, version),
      local.db.prepare("INSERT INTO sessions VALUES(?,'participant','old-person',?,NULL)").bind(digest(oldPerson), Date.now() + 3600000),
      local.db.prepare("INSERT INTO candidates VALUES('old-wine',1,'Preserved wine','candidates/old-photo','image/png','old-upload')"),
      local.db.prepare("UPDATE activities SET status='open',started_at='2026-01-01' WHERE id='byob'"),
      local.db.prepare("INSERT INTO answers VALUES('byob','old-person',?,?)").bind('{"ranking":["old-wine"]}', '2026-01-01'),
      local.db.prepare("UPDATE activities SET status='closed',published=1 WHERE id='byob'"),
      local.db.prepare("INSERT INTO vote_history VALUES('old-history',0,'2026-01-01',?)").bind(JSON.stringify(snapshot))
    ]);
    const bucket = await local.mf.getR2Bucket('PHOTOS'); await bucket.put('candidates/old-photo', PNG);
    const tables = ['event', 'activities', 'participants', 'answers', 'candidates', 'vote_history', 'candidate_photo_cleanup', 'admin_credentials', 'admin_bootstrap_history'];
    const dump = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
    const before = await dump();
    const schema = (await local.db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).results;
    const person = client(local.mf, `${legacyCookies.PARTICIPANT_SESSION_COOKIE}=${oldPerson}`), oldStandalone = client(local.mf, `${legacyCookies.ADMIN_SESSION_COOKIE}=${oldAdmin}`);
    assert.equal((await person('/api/bootstrap')).body.participant.id, 'old-person');
    assert.equal((await person('/v/owner/api/bootstrap')).body.participant.id, 'old-person');
    assert.equal((await oldStandalone('/api/admin/state')).status, 401);
    const owner = memberClient(local.mf); await loginOwner(owner);
    assert.equal((await state(owner)).currentHistoryId, 'old-history');
    assert.equal((await owner('/api/admin/history/old-history')).body.record.rows[0].name, 'Preserved wine');
    assert.equal((await person('/v/owner/api/photos/old-wine')).status, 200);
    const member = memberClient(local.mf), account = await signup(member, 'legacy-isolated@example.test');
    await approve(owner, member, account);
    assert.equal((await member('/api/admin/candidates', 'POST', photo('New member wine'))).status, 200);
    assert.equal((await member('/api/admin/reset-all', 'POST', { ...expected(await state(member)), confirm: 'reset-all' })).status, 200);
    assert.deepEqual(await dump(), before);
    const originalNames = new Set(schema.map(row => row.name));
    assert.deepEqual((await local.db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).results.filter(row => originalNames.has(row.name)), schema);
    assert.deepEqual(Buffer.from(await (await bucket.get('candidates/old-photo')).arrayBuffer()), PNG);
    assert.equal((await person('/api/bootstrap')).body.participant.submitted.byob, true);
    assert.equal((await person('/v/owner/api/bootstrap')).body.participant.submitted.byob, true);
    const secondOwner = memberClient(local.mf); await loginOwner(secondOwner);
    const memberSessions = (await local.db.prepare('SELECT * FROM member_sessions WHERE member_id=? ORDER BY token_hash').bind(account.id).all()).results;
    const memberAdmins = (await local.db.prepare(`SELECT * FROM m_${account.id}_sessions ORDER BY token_hash`).all()).results;
    const participantSessions = (await local.db.prepare("SELECT * FROM sessions WHERE role='participant' ORDER BY token_hash").all()).results;
    assert.equal((await owner('/api/admin/sessions', 'DELETE')).status, 200);
    assert.equal((await owner('/api/admin/state')).status, 401);
    assert.equal((await secondOwner('/api/admin/state')).status, 401);
    assert.equal((await secondOwner('/api/members/session')).body.authenticated, false);
    assert.deepEqual((await local.db.prepare('SELECT * FROM member_sessions WHERE member_id=? ORDER BY token_hash').bind(account.id).all()).results, memberSessions);
    assert.deepEqual((await local.db.prepare(`SELECT * FROM m_${account.id}_sessions ORDER BY token_hash`).all()).results, memberAdmins);
    assert.deepEqual((await local.db.prepare("SELECT * FROM sessions WHERE role='participant' ORDER BY token_hash").all()).results, participantSessions);
    assert.equal((await state(member)).candidates.length, 0);
    assert.equal((await person('/v/owner/api/bootstrap')).body.participant.id, 'old-person');
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});

test('membership revocation between route authentication and SQL write is rejected by the existing atomic admin guard', async () => {
  const local = await createApp({ bindings });
  try {
    const owner = memberClient(local.mf), member = memberClient(local.mf);
    await loginOwner(owner); const account = await signup(member, 'write-race@example.test'); await approve(owner, member, account);
    const auth = await member('/api/members/login', 'POST', { email: 'write-race@example.test', password: memberPassword });
    const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'], loader: { '.sql': 'text' } });
    const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    let revoked = false;
    const DB = { batch: statements => local.db.batch(statements), prepare(sql) {
      const statement = local.db.prepare(sql);
      if (!sql.startsWith(`UPDATE m_${account.id}_event`)) return statement;
      return { bind(...args) { return { async run() {
        revoked = true;
        await local.db.prepare('DELETE FROM member_sessions WHERE member_id=?').bind(account.id).run();
        return statement.bind(...args).run();
      } }; } };
    } };
    const before = await local.db.prepare(`SELECT title FROM m_${account.id}_event`).first();
    const response = await worker.fetch(new Request('https://vote.test/api/admin/event', { method: 'PATCH', headers: { Origin: 'https://vote.test', Cookie: cookie, 'Content-Type': 'application/json', 'x-member-csrf': auth.body.csrfToken },
      body: JSON.stringify({ title: 'Must not change', startsAt: '2026-12-01T12:00:00+09:00', timezone: 'Asia/Seoul' }) }), { ...bindings, DB, PHOTOS: await local.mf.getR2Bucket('PHOTOS') });
    assert(revoked, `write was not reached: ${response.status} ${await response.clone().text()}`); assert.equal(response.status, 401);
    assert.deepEqual(await local.db.prepare(`SELECT title FROM m_${account.id}_event`).first(), before);
  } finally { await local.mf.dispose(); }
});
