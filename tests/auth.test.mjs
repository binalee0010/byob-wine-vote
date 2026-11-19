import test from 'node:test';
import assert from 'node:assert/strict';
import { client, createApp, TEST_PASSWORD } from './harness.mjs';

test('admin authentication, CSRF, password changes and revocation preserve participant ballots', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf), second = client(local.mf), person = client(local.mf), anon = client(local.mf);
    assert.equal((await anon('/api/admin/state')).status, 401);
    assert.equal((await admin('/api/admin/login', 'POST', { password: 'incorrect' })).status, 401);
    const authenticated = await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD });
    assert.equal(authenticated.status, 200);
    assert.match(authenticated.headers.get('set-cookie'), /^__Host-byob_admin=.*HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await second('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const joined = await person('/api/session', 'POST', { name: 'Synthetic participant' });
    assert.equal(joined.status, 200);
    assert.match(joined.headers.get('set-cookie'), /^__Host-byob_participant=/);
    assert.equal((await person('/api/admin/state')).status, 401);
    assert.equal((await person('/api/session', 'DELETE', undefined, { headers: { Origin: '' } })).status, 403);
    const added = await admin('/api/admin/candidates', 'POST', { name: 'Synthetic candidate', requestId: crypto.randomUUID(), revision: 0 });
    assert.equal(added.status, 200);
    const ranking = [added.body.candidate.id];
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    assert.equal((await person('/api/activities/byob/answer', 'PUT', { ranking, revision: 0 })).status, 200);
    const before = (await admin('/api/admin/state')).body;
    const participantSessions = (await local.db.prepare("SELECT * FROM sessions WHERE role='participant'").all()).results;
    const nextPassword = 'Synthetic-new-password!';
    const change = (request, patch = {}, options) => request('/api/admin/password', 'POST', { currentPassword: TEST_PASSWORD, newPassword: nextPassword, ...patch }, options);
    assert.equal((await change(anon)).status, 401);
    assert.equal((await change(admin, {}, { headers: { Origin: 'https://other.test' } })).status, 403);
    for (const newPassword of ['123456789', 'x'.repeat(1025), null]) assert.equal((await change(admin, { newPassword })).status, 400);
    assert.equal((await change(admin, { currentPassword: 'incorrect' })).body.code, 'invalid_current_password');
    const changed = await change(admin);
    assert.equal(changed.status, 200);
    assert.match(changed.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await admin('/api/admin/state')).status, 401);
    assert.equal((await second('/api/admin/state')).status, 401);
    assert.equal((await anon('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 401);
    assert.equal((await anon('/api/admin/login', 'POST', { password: nextPassword })).status, 200);
    assert.deepEqual((await anon('/api/admin/state')).body, before);
    assert.deepEqual((await person('/api/activities/byob')).body.mine, { ranking });
    assert.deepEqual((await local.db.prepare("SELECT * FROM sessions WHERE role='participant'").all()).results, participantSessions);
    const credential = await local.db.prepare('SELECT * FROM admin_credentials').first();
    assert.match(credential.password_hash, /^scrypt\$16384\$16\$1\$/);
    assert(!credential.password_hash.includes(nextPassword));
    assert(!JSON.stringify(before).includes('password_hash'));
    assert.equal((await anon('/api/admin/session', 'DELETE')).status, 200);
    assert.equal((await anon('/api/admin/state')).status, 401);
    assert.equal((await person('/api/bootstrap')).body.participant.id, joined.body.participant.id);
  } finally { await local.mf.dispose(); }
});

test('concurrent failed logins are rate limited and password changes reject stale credential sessions', async () => {
  const local = await createApp();
  try {
    const anon = client(local.mf), admin = client(local.mf), second = client(local.mf);
    const options = { headers: { 'CF-Connecting-IP': '192.0.2.1' } };
    for (let i = 0; i < 6; i++) assert.equal((await anon('/api/admin/login', 'POST', { password: 'incorrect' }, options)).status, 401);
    const rejected = await Promise.all(Array.from({ length: 4 }, () => anon('/api/admin/login', 'POST', { password: 'incorrect' }, options)));
    assert.equal(rejected.filter(response => response.status === 429).length, 2);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    assert.equal((await second('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const oldVersion = (await local.db.prepare('SELECT version FROM admin_credentials').first()).version;
    const changes = await Promise.all([admin('/api/admin/password', 'POST', { currentPassword: TEST_PASSWORD, newPassword: 'Concurrent-one-password!' }), second('/api/admin/password', 'POST', { currentPassword: TEST_PASSWORD, newPassword: 'Concurrent-two-password!' })]);
    assert.equal(changes.filter(response => response.status === 200).length, 1);
    assert(changes.every(response => [200, 401, 403, 409].includes(response.status)));
    assert.equal((await admin('/api/admin/state')).status, 401);
    assert.equal((await second('/api/admin/state')).status, 401);
    await assert.rejects(local.db.prepare("INSERT INTO sessions(token_hash,role,participant_id,expires_at,credential_version) VALUES(?,'admin',NULL,?,?)")
      .bind('a'.repeat(64), Date.now() + 60000, oldVersion).run(), /credential_changed/);
    const password = changes[0].status === 200 ? 'Concurrent-one-password!' : 'Concurrent-two-password!';
    assert.equal((await anon('/api/admin/login', 'POST', { password })).status, 200);
  } finally { await local.mf.dispose(); }
});
