import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { client, createApp, TEST_PASSWORD } from './harness.mjs';

const bundle = await build({ entryPoints: ['worker/password-reset.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'] });
const { requestPasswordReset, confirmPasswordReset } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const ownerEmail = 'owner@example.test', memberPassword = 'Original-member-password!', nextPassword = '24';
const smtp = JSON.stringify({ secure: true, host: 'smtp.example.test', port: 465, user: 'synthetic', pass: 'synthetic', from: 'BYOB <noreply@example.test>' });
const digest = value => createHash('sha256').update(value).digest('hex');
async function environment(local, overrides = {}) {
  return { DB: local.db, SUPERADMIN_EMAIL: ownerEmail, PUBLIC_ORIGIN: 'https://canonical.example.test', SMTP_CONFIG: smtp,
    PASSWORD_VERIFIER: await local.mf.getDurableObjectNamespace('PASSWORD_VERIFIER'), ...overrides };
}
function memberClient(mf, ip) {
  const api = client(mf); let csrf;
  return async (path, method = 'GET', data, options = {}) => {
    const response = await api(path, method, data, { ...options, headers: { 'CF-Connecting-IP': ip, ...(csrf ? { 'X-Member-CSRF': csrf } : {}), ...options.headers } });
    if (response.body && 'csrfToken' in response.body) csrf = response.body.csrfToken;
    return response;
  };
}
async function issue(env, address) {
  let delivered;
  await requestPasswordReset(env, address, async (_env, notice) => { delivered = notice; });
  assert.equal(delivered?.email, address);
  assert.match(delivered.token, /^[a-f0-9]{64}$/);
  return delivered.token;
}
const confirm = (api, token, newPassword = nextPassword) => api('/api/members/password-reset/confirm', 'POST', { token, newPassword });
const resetRequest = (api, email, options) => api('/api/members/password-reset/request', 'POST', { email }, options);

test('reset requests conceal registration, validate origin and body, and limit requests and token guesses', async () => {
  const local = await createApp({ bindings: { SUPERADMIN_EMAIL: ownerEmail } });
  try {
    const api = memberClient(local.mf, '192.0.2.51');
    const owner = await resetRequest(api, ownerEmail), absent = await resetRequest(api, 'absent@example.test');
    assert.equal(owner.status, 503); assert.deepEqual(owner.body, absent.body);
    assert.equal((await resetRequest(api, 'bad address')).status, 400);
    assert.equal((await resetRequest(api, ownerEmail, { headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await resetRequest(api, 'x'.repeat(5000))).status, 413);
    const env = await environment(local), sent = [];
    await requestPasswordReset(env, 'unknown@example.test', async (...args) => sent.push(args));
    assert.deepEqual(sent, []);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM member_password_resets').first()).n, 0);
    const limited = memberClient(local.mf, '192.0.2.52');
    for (let n = 0; n < 3; n++) assert.equal((await resetRequest(limited, 'rate@example.test')).status, 503);
    assert.equal((await resetRequest(limited, ' RATE@EXAMPLE.TEST ')).status, 429);
    const ipLimited = memberClient(local.mf, '192.0.2.53');
    for (let n = 0; n < 10; n++) assert.equal((await resetRequest(ipLimited, `unknown${n}@example.test`)).status, 503);
    assert.equal((await resetRequest(ipLimited, 'extra@example.test')).status, 429);
    const guesses = memberClient(local.mf, '192.0.2.54');
    for (let n = 0; n < 12; n++) assert.equal((await confirm(guesses, 'f'.repeat(64))).body.code, 'invalid_reset_token');
    assert.equal((await confirm(guesses, 'f'.repeat(64))).status, 429);
  } finally { await local.mf.dispose(); }
});

test('a member email link resets once, revokes own sessions and preserves approval, other accounts and voting data', async () => {
  const local = await createApp({ bindings: { SUPERADMIN_EMAIL: ownerEmail } });
  try {
    const owner = memberClient(local.mf, '192.0.2.60'), member = memberClient(local.mf, '192.0.2.61'), second = memberClient(local.mf, '192.0.2.62'), other = memberClient(local.mf, '192.0.2.63');
    assert.equal((await owner('/api/members/login', 'POST', { email: ownerEmail, password: TEST_PASSWORD })).status, 200);
    const signed = await member('/api/members/signup', 'POST', { email: 'member@example.test', password: memberPassword }), id = signed.body.member.id;
    assert.equal((await owner(`/api/members/requests/${id}/approve`, 'POST', {})).status, 200);
    assert.equal((await member('/api/members/session')).body.member.status, 'approved');
    assert.equal((await second('/api/members/login', 'POST', { email: 'member@example.test', password: memberPassword })).status, 200);
    assert.equal((await other('/api/members/signup', 'POST', { email: 'other@example.test', password: memberPassword })).status, 201);
    await local.db.batch([
      local.db.prepare(`INSERT INTO m_${id}_participants(id,name,name_key) VALUES('voter','Voter','voter')`),
      local.db.prepare(`INSERT INTO m_${id}_sessions(token_hash,role,participant_id,expires_at,credential_version) VALUES(?,'participant','voter',?,NULL)`).bind('e'.repeat(64), Date.now() + 60000)
    ]);
    const before = await local.db.prepare(`SELECT * FROM m_${id}_event`).first();
    const env = await environment(local), firstToken = await issue(env, 'member@example.test'), secondToken = await issue(env, 'member@example.test');
    const stored = (await local.db.prepare('SELECT * FROM member_password_resets ORDER BY token_hash').all()).results;
    assert.equal(stored.length, 2); assert(stored.some(row => row.token_hash === digest(firstToken)));
    assert(!JSON.stringify(stored).includes(firstToken)); assert(!JSON.stringify(stored).includes(secondToken));
    assert(stored.every(row => row.expires_at > Date.now() + 29 * 60000 && row.expires_at <= Date.now() + 30 * 60000));
    assert.equal((await confirm(member, firstToken, '')).status, 400);
    assert.equal((await confirm(member, 'f'.repeat(64))).body.code, 'invalid_reset_token');
    const reset = await confirm(member, firstToken);
    assert.equal(reset.status, 200); assert.deepEqual(reset.body, { ok: true });
    assert.equal((await confirm(second, firstToken)).body.code, 'invalid_reset_token');
    assert.equal((await confirm(second, secondToken)).body.code, 'invalid_reset_token');
    assert.equal((await member('/api/members/session')).body.authenticated, false);
    assert.equal((await second('/api/members/session')).body.authenticated, false);
    assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM m_${id}_sessions WHERE role='admin'`).first()).n, 0);
    assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM m_${id}_sessions WHERE role='participant'`).first()).n, 1);
    assert.deepEqual(await local.db.prepare(`SELECT * FROM m_${id}_event`).first(), before);
    assert.equal((await owner('/api/members/session')).body.authenticated, true);
    assert.equal((await other('/api/members/session')).body.authenticated, true);
    assert.equal((await member('/api/members/login', 'POST', { email: 'member@example.test', password: memberPassword })).status, 401);
    const login = await member('/api/members/login', 'POST', { email: 'member@example.test', password: nextPassword });
    assert.equal(login.status, 200); assert.equal(login.body.member.status, 'approved'); assert.equal(login.body.member.workspaceSlug, id);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});

test('concurrent resets and password changes permit one credential update and invalidate every prior link', async () => {
  const local = await createApp({ bindings: { SUPERADMIN_EMAIL: ownerEmail } });
  try {
    const member = memberClient(local.mf, '192.0.2.70'), anon = memberClient(local.mf, '192.0.2.71');
    await member('/api/members/signup', 'POST', { email: 'race@example.test', password: memberPassword });
    const env = await environment(local), token = await issue(env, 'race@example.test');
    const passwords = ['Concurrent-password-one!', 'Concurrent-password-two!'];
    const results = await Promise.all(passwords.map(password => confirm(anon, token, password)));
    assert.deepEqual(results.map(row => row.status).sort(), [200, 400]);
    const current = passwords[results.findIndex(row => row.status === 200)];
    assert.equal((await member('/api/members/login', 'POST', { email: 'race@example.test', password: current })).status, 200);
    const stale = await issue(env, 'race@example.test');
    const changed = await Promise.all([
      member('/api/members/password', 'POST', { currentPassword: current, newPassword: 'Changed-by-session-password!' }),
      confirm(anon, stale, 'Changed-by-email-password!')
    ]);
    assert.equal(changed.filter(row => row.status === 200).length, 1);
    assert(changed.every(row => [200, 400, 403, 409].includes(row.status)));
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM member_password_resets').first()).n, 0);
  } finally { await local.mf.dispose(); }
});

test('expired, renamed, recreated, reassigned and failed-delivery links cannot reset an account', async () => {
  const local = await createApp({ bindings: { SUPERADMIN_EMAIL: ownerEmail } });
  try {
    const member = memberClient(local.mf, '192.0.2.80'), anon = memberClient(local.mf, '192.0.2.81');
    const signed = await member('/api/members/signup', 'POST', { email: 'boundary@example.test', password: memberPassword }), id = signed.body.member.id;
    const env = await environment(local), expired = await issue(env, 'boundary@example.test');
    await local.db.prepare('UPDATE member_password_resets SET expires_at=0 WHERE token_hash=?').bind(digest(expired)).run();
    assert.equal((await confirm(anon, expired)).body.code, 'invalid_reset_token');
    const renamed = await issue(env, 'boundary@example.test');
    await local.db.prepare('UPDATE members SET email=? WHERE id=?').bind('renamed@example.test', id).run();
    assert.equal((await confirm(anon, renamed)).body.code, 'invalid_reset_token');
    const reassigned = await issue(env, 'renamed@example.test');
    await assert.rejects(confirmPasswordReset({ ...env, SUPERADMIN_EMAIL: 'different-owner@example.test' }, reassigned, nextPassword), error => error.code === 'invalid_reset_token');
    let delivered = false;
    await requestPasswordReset({ ...env, SUPERADMIN_EMAIL: 'renamed@example.test' }, 'renamed@example.test', async () => { delivered = true; });
    assert.equal(delivered, false);
    const recreated = await issue(env, 'renamed@example.test');
    await local.db.batch([local.db.prepare('DELETE FROM member_notice_outbox WHERE member_id=?').bind(id), local.db.prepare('DELETE FROM members WHERE id=?').bind(id)]);
    const fresh = await member('/api/members/signup', 'POST', { email: 'renamed@example.test', password: memberPassword });
    assert.equal(fresh.status, 201); assert.notEqual(fresh.body.member.id, id);
    assert.equal((await confirm(anon, recreated)).body.code, 'invalid_reset_token');
    let failedToken;
    await requestPasswordReset(env, 'renamed@example.test', async (_env, notice) => { failedToken = notice.token; throw new Error('synthetic SMTP failure'); });
    assert.equal((await confirm(anon, failedToken)).body.code, 'invalid_reset_token');
    const retry = await issue(env, 'renamed@example.test');
    assert.equal((await confirm(anon, retry)).status, 200);
    assert.equal((await member('/api/members/login', 'POST', { email: 'renamed@example.test', password: nextPassword })).body.member.status, 'pending');
  } finally { await local.mf.dispose(); }
});

test('owner recovery works before first login and revokes existing owner sessions without changing members', async () => {
  const local = await createApp({ bindings: { SUPERADMIN_EMAIL: ownerEmail } });
  try {
    const env = await environment(local), anon = memberClient(local.mf, '192.0.2.90'), owner = memberClient(local.mf, '192.0.2.91'), second = memberClient(local.mf, '192.0.2.92');
    const first = await issue(env, ownerEmail);
    assert.equal(await local.db.prepare("SELECT * FROM members WHERE id='owner'").first(), null);
    assert.equal((await confirm(anon, first, 'Recovered-owner-password!')).status, 200);
    assert.equal((await owner('/api/members/login', 'POST', { email: ownerEmail, password: TEST_PASSWORD })).status, 401);
    assert.equal((await owner('/api/members/login', 'POST', { email: ownerEmail, password: 'Recovered-owner-password!' })).status, 200);
    assert.equal((await second('/api/members/login', 'POST', { email: ownerEmail, password: 'Recovered-owner-password!' })).status, 200);
    const member = memberClient(local.mf, '192.0.2.93');
    const signed = await member('/api/members/signup', 'POST', { email: 'preserved@example.test', password: memberPassword });
    const before = await local.db.prepare('SELECT * FROM members WHERE id=?').bind(signed.body.member.id).first();
    const reset = await issue(env, ownerEmail), concurrent = await issue(env, ownerEmail);
    const results = await Promise.all([confirm(anon, reset, 'Recovered-owner-again!'), confirm(anon, concurrent, 'Recovered-owner-concurrent!')]);
    assert.deepEqual(results.map(row => row.status).sort(), [200, 400]);
    assert.equal((await owner('/api/members/session')).body.authenticated, false);
    assert.equal((await second('/api/members/session')).body.authenticated, false);
    assert.equal((await local.db.prepare("SELECT count(*) AS n FROM sessions WHERE role='admin'").first()).n, 0);
    assert.deepEqual(await local.db.prepare('SELECT * FROM members WHERE id=?').bind(signed.body.member.id).first(), before);
    assert.equal((await member('/api/members/session')).body.authenticated, true);
    const oldLink = await issue(env, ownerEmail);
    const changedEnv = { ...env, SUPERADMIN_EMAIL: 'new-owner@example.test' };
    let sent = false;
    await requestPasswordReset(changedEnv, 'new-owner@example.test', async () => { sent = true; });
    assert.equal(sent, false);
    await assert.rejects(confirmPasswordReset(changedEnv, oldLink, nextPassword), error => error.code === 'invalid_reset_token');
  } finally { await local.mf.dispose(); }
});

test('fresh and existing password-reset migrations are identical and preserve all prior data and schema', async () => {
  const migration = await readFile(new URL('../migrations/0003_password_reset.sql', import.meta.url), 'utf8');
  assert.equal(await readFile(new URL('../migrations-existing/0014_password_reset.sql', import.meta.url), 'utf8'), migration);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    db.exec(await readFile(new URL('../migrations/0002_members.sql', import.meta.url), 'utf8'));
    db.exec("INSERT INTO participants(id,name,name_key) VALUES('preserved','Preserved','preserved'); INSERT INTO vote_history(id,revision,saved_at,snapshot) VALUES('preserved',0,'2026-01-01','{}')");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const rows = tables.map(({ name }) => [name, db.prepare(`SELECT * FROM \"${name}\" ORDER BY rowid`).all()]);
    const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    db.exec(migration);
    for (const [name, before] of rows) assert.deepEqual(db.prepare(`SELECT * FROM \"${name}\" ORDER BY rowid`).all(), before);
    for (const { name, sql } of schema) assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name).sql, sql);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
