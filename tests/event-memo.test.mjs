import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createApp, client, TEST_PASSWORD } from './harness.mjs';

for (const legacy of [false, true]) test(`private optional memo preserves exact text, unrelated settings and poll data (${legacy ? 'legacy' : 'fresh'})`, async () => {
  const local = await createApp({ legacy });
  try {
    const admin = client(local.mf), person = client(local.mf), anon = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const state = async () => (await admin('/api/admin/state')).body;
    const save = event => admin('/api/admin/settings', 'PATCH', { event });
    assert.equal((await state()).event.memo, '');
    assert.equal((await person('/api/session', 'POST', { name: 'Memo participant' })).status, 200);
    const wine = (await admin('/api/admin/candidates', 'POST', { name: 'Memo wine', requestId: 'memo-wine', revision: 0 })).body.candidate;
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    assert.equal((await person('/api/activities/byob/answer', 'PUT', { ranking: [wine.id], revision: 0 })).status, 200);
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'close', revision: 0 })).status, 200);
    const tables = ['activities', 'participants', 'answers', 'candidates', 'vote_history'];
    const dump = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
    const before = await dump(), scores = (await state()).byobResults;
    const memo = '  Ｗｉｎｅ note\nSecond line\r\nThird\tline  ';
    assert.equal((await anon('/api/admin/settings', 'PATCH', { event: { memo } })).status, 401);
    assert.equal((await admin('/api/admin/settings', 'PATCH', { event: { memo } }, { headers: { Origin: 'https://other.test' } })).status, 403);
    assert.equal((await save({ memo })).status, 200);
    assert.equal((await state()).event.memo, memo);
    assert.equal((await save({ title: 'Title edit only' })).status, 200);
    assert.equal((await state()).event.memo, memo);
    for (const invalid of [null, 1, {}, 'x'.repeat(2001), '😀'.repeat(1001), 'bad\u0000memo', 'bad\u000bmemo']) {
      assert.equal((await save({ title: 'Must not save', memo: invalid })).status, 400);
      assert.equal((await state()).event.title, 'Title edit only');
      assert.equal((await state()).event.memo, memo);
    }
    assert.equal((await admin('/api/admin/settings', 'PATCH', { event: { memo: 'Must not save' }, activities: [{ id: 'byob', revision: 1, resultVisibility: 'public' }] })).status, 409);
    assert.equal((await state()).event.memo, memo);
    assert.equal((await save({ memo: '😀'.repeat(1000) })).status, 200);
    assert.equal((await state()).event.memo.length, 2000);
    assert.equal((await save({ memo: '' })).status, 200);
    assert.equal((await state()).event.memo, '');
    assert.deepEqual(await dump(), before); assert.deepEqual((await state()).byobResults, scores);
    assert.equal((await save({ memo })).status, 200);
    assert.equal(Object.hasOwn((await anon('/api/bootstrap')).body.event, 'memo'), false);
    assert.equal(Object.hasOwn((await person('/api/bootstrap')).body.event, 'memo'), false);
    assert.equal((await admin('/api/admin/settings', 'PATCH', { activities: [{ id: 'byob', revision: 0, resultVisibility: 'public' }] })).status, 200);
    const results = await anon('/api/results/byob'); assert.equal(results.status, 200);
    assert.equal(JSON.stringify(results.body).includes(memo), false);
    assert.equal(Object.hasOwn(results.body, 'memo'), false);
  } finally { await local.mf.dispose(); }
});

test('older namespaces gain memo and audience schema on concurrent access without changing their rows', async () => {
  const bindings = { SUPERADMIN_EMAIL: 'owner@example.test' };
  const local = await createApp({ bindings });
  try {
    const member = client(local.mf), anon = client(local.mf);
    const signup = await member('/api/members/signup', 'POST', { email: 'upgrade@example.test', password: 'Synthetic-member-password!' });
    assert.equal(signup.status, 201); const account = signup.body.member, namespace = `m_${account.id}`;
    await local.db.prepare("UPDATE members SET status='approved' WHERE id=?").bind(account.id).run();
    const bundle = await build({ entryPoints: ['worker/workspaces.ts'], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.sql': 'text' } });
    const { workspaceSql } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    for (const file of ['0001_initial.sql', '0004_candidate_description.sql', '0006_participant_entries.sql']) {
      const schema = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      for (const sql of schema.split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(s => s && !/^PRAGMA\b/.test(s))) await local.db.prepare(workspaceSql(sql, namespace)).run();
    }
    await local.db.batch([
      local.db.prepare(`UPDATE ${namespace}_event SET title='Existing poll'`),
      local.db.prepare(`INSERT INTO ${namespace}_participants VALUES('old-person','Existing entrant','existing entrant')`),
      local.db.prepare(`INSERT INTO ${namespace}_participant_entries VALUES('old-person',1)`),
      local.db.prepare(`INSERT INTO ${namespace}_participants VALUES('old-nonvoter','Existing nonvoter','existing nonvoter')`),
      local.db.prepare(`INSERT INTO ${namespace}_participant_entries VALUES('old-nonvoter',1)`),
      local.db.prepare(`INSERT INTO ${namespace}_participants VALUES('old-roster','Never joined','never joined')`),
      local.db.prepare(`INSERT INTO ${namespace}_candidates(id,number,name,object_key,content_type,request_id) VALUES('old-wine',1,'Existing wine','','','old-upload')`),
      local.db.prepare(`UPDATE ${namespace}_activities SET status='open',started_at='2026-01-01'`),
      local.db.prepare(`INSERT INTO ${namespace}_answers VALUES('byob','old-person','{"ranking":["old-wine"]}','old-time')`),
      local.db.prepare(`UPDATE ${namespace}_activities SET status='closed',published=1`)
    ]);
    const tables = ['participants', 'answers', 'candidates'];
    const dump = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await local.db.prepare(`SELECT * FROM ${namespace}_${table}`).all()).results])));
    const before = await dump();
    const responses = await Promise.all(Array.from({ length: 4 }, () => anon(`/v/${account.workspaceSlug}/api/bootstrap`)));
    assert(responses.every(response => response.status === 200), JSON.stringify(responses));
    assert(responses.every(response => !Object.hasOwn(response.body.event, 'memo')));
    assert.equal((await local.db.prepare(`SELECT memo FROM ${namespace}_event`).first()).memo, '');
    assert.equal((await local.db.prepare(`SELECT result_visibility FROM ${namespace}_activities`).first()).result_visibility, 'public');
    assert.deepEqual(await dump(), before);
    assert.equal((await local.db.prepare(`SELECT count(*) AS n FROM ${namespace}_participant_round_entries WHERE participant_id='old-person' AND revision=0`).first()).n, 1);
    assert.equal((await anon(`/v/${account.workspaceSlug}/api/results/byob`)).body.rows[0].points, 1);
    const login = await member('/api/members/login', 'POST', { email: account.email, password: 'Synthetic-member-password!' }); assert.equal(login.status, 200);
    const csrf = login.body.csrfToken;
    assert.equal((await member(`/v/${account.workspaceSlug}/api/admin/settings`, 'PATCH', { event: { memo: 'Upgraded\nprivate note' } }, { headers: { 'x-member-csrf': csrf } })).status, 200);
    assert.equal((await member(`/v/${account.workspaceSlug}/api/admin/state`)).body.event.memo, 'Upgraded\nprivate note');
    assert.equal((await member(`/v/${account.workspaceSlug}/api/admin/settings`, 'PATCH', { activities: [{ id: 'byob', revision: 0, resultVisibility: 'participants' }] }, { headers: { 'x-member-csrf': csrf } })).status, 200);
    const nonvoter = client(local.mf);
    assert.equal((await nonvoter(`/v/${account.workspaceSlug}/api/session`, 'POST', { name: 'Existing nonvoter' })).status, 200);
    const privateResult = await nonvoter(`/v/${account.workspaceSlug}/api/results/byob`);
    assert.equal(privateResult.status, 200); assert.equal(privateResult.body.participantId, 'old-nonvoter');
    assert.equal(Object.hasOwn(privateResult.body, 'participants'), false);
    assert.equal(JSON.stringify(privateResult.body).includes('Existing entrant'), false);
    assert.equal((await anon(`/v/${account.workspaceSlug}/api/session`, 'POST', { name: 'Never joined' })).body.code, 'participant_not_entered');
    assert.deepEqual(await dump(), before);
    assert.equal((await local.db.prepare('SELECT memo FROM event').first()).memo, '');
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});
