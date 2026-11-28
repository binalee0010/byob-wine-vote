import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { client, createApp, photo, PNG, TEST_PASSWORD } from './harness.mjs';

const state = async (api, base = '/api') => (await api(`${base}/admin/state`)).body;
const settings = (api, patch, revision = 0, base = '/api', event) => api(`${base}/admin/settings`, 'PATCH', { event, activities: [{ id: 'byob', revision, ...patch }] });
const control = (api, action, revision = 0, base = '/api') => api(`${base}/admin/activities/byob/state`, 'POST', { action, revision });
const reset = (api, expectedRevision = 0, base = '/api') => api(`${base}/admin/activities/byob/reset`, 'POST', { confirm: 'reset', expectedRevision });
const ids = candidates => candidates.map(candidate => candidate.id);
const dump = async (db, prefix = '') => Object.fromEntries(await Promise.all(['event', 'activities', 'participants', 'sessions', 'participant_entries', 'participant_round_entries', 'candidates', 'answers', 'vote_history', 'candidate_photo_cleanup']
  .map(async table => [table, (await db.prepare(`SELECT * FROM ${prefix}${table} ORDER BY rowid`).all()).results])));
async function login(admin) { assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200); }
async function wines(admin, base = '/api') {
  const uploaded = await admin(`${base}/admin/candidates`, 'POST', photo('Photographed wine')); assert.equal(uploaded.status, 200);
  for (let i = 1; i < 5; i++) assert.equal((await admin(`${base}/admin/candidates`, 'POST', { name: `Wine ${i}`, requestId: `candidate-${i}`, revision: 0 })).status, 200);
  const candidates = (await state(admin, base)).candidates;
  const order = [candidates[4].id, candidates[2].id, candidates[0].id, candidates[3].id, candidates[1].id];
  assert.equal((await admin(`${base}/admin/candidates/order`, 'PUT', { ids: order, revision: 0 })).status, 200);
  return (await state(admin, base)).candidates;
}

for (const method of ['winner', 'custom', 'full']) test(`registered and stable per-participant random display preserve ballots and ${method} scoring`, async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf), anon = client(local.mf), people = Array.from({ length: 8 }, () => client(local.mf));
    await login(admin); const canonical = await wines(admin);
    const initial = await state(admin); assert.equal(initial.activities[0].candidateOrder, 'registered');
    assert.equal((await anon('/api/bootstrap')).body.activities[0].candidateOrder, 'registered');
    const methodSettings = { votingMethod: method, ...(method === 'custom' ? { rankPoints: [8, 3, 0] } : {}) };
    assert.equal((await settings(admin, methodSettings)).status, 200);
    const joined = await people[0]('/api/session', 'POST', { name: 'Stable participant 0' });
    assert.equal((await control(admin, 'open')).status, 200);
    assert.equal((await anon('/api/activities/byob')).status, 401);
    assert.deepEqual((await people[0]('/api/activities/byob')).body.candidates, canonical);
    assert.equal((await reset(admin)).status, 200);
    assert.equal((await settings(admin, { candidateOrder: 'random', resultVisibility: 'public' }, 1)).status, 200);
    assert.equal((await control(admin, 'open', 1)).status, 200);
    const orders = [];
    for (const [index, person] of people.entries()) {
      assert.equal((await person('/api/session', 'POST', { name: `Stable participant ${index}` })).status, 200);
      const first = await person('/api/activities/byob'); assert.equal(first.status, 200);
      const detail = first.body; assert.equal(detail.activity.candidateOrder, 'random');
      assert.deepEqual(detail.candidates.slice().sort((a, b) => a.number - b.number), canonical);
      assert.deepEqual((await person('/api/activities/byob')).body.candidates, detail.candidates);
      orders.push(ids(detail.candidates));
    }
    assert(new Set(orders.map(JSON.stringify)).size > 1, 'participants should receive varied permutations');
    const sameName = client(local.mf);
    assert.equal((await sameName('/api/session', 'POST', { name: 'STABLE PARTICIPANT 0' })).body.participant.id, joined.body.participant.id);
    assert.deepEqual(ids((await sameName('/api/activities/byob')).body.candidates), orders[0]);
    const count = method === 'winner' ? 1 : method === 'custom' ? 3 : canonical.length;
    const ranking = ids(canonical).reverse().slice(0, count);
    assert.equal((await people[0]('/api/activities/byob/answer', 'PUT', { ranking, revision: 1 })).status, 200);
    const saved = await dump(local.db);
    assert.deepEqual((await sameName('/api/activities/byob')).body.mine, { ranking });
    assert.deepEqual(ids((await sameName('/api/activities/byob')).body.candidates), orders[0]);
    assert.deepEqual(await dump(local.db), saved, 'detail shuffling must not write any DB rows');
    const host = await state(admin); assert.deepEqual(host.candidates, canonical);
    const expectedScores = new Map(ranking.map((id, index) => [id, method === 'winner' ? 1 : method === 'custom' ? [8, 3, 0][index] : canonical.length - index]));
    for (const row of host.byobResults) assert.equal(row.votes ?? row.points, expectedScores.get(row.id) ?? 0);
    const photoUrl = canonical.find(candidate => candidate.photoUrl).photoUrl;
    const imageResponse = await local.mf.dispatchFetch(`https://vote.test${photoUrl}`);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), PNG);
    assert.equal((await control(admin, 'close', 1)).status, 200);
    assert.deepEqual((await anon('/api/results/byob')).body.rows, host.byobResults);
    assert.equal((await reset(admin, 1)).status, 200);
    assert.equal((await state(admin)).activities[0].candidateOrder, 'random');
    assert.equal((await control(admin, 'open', 2)).status, 200);
    let changed = false;
    for (const [index, person] of people.entries()) {
      assert.equal((await person('/api/session', 'POST', { name: `Stable participant ${index}` })).status, 200);
      const next = (await person('/api/activities/byob')).body.candidates;
      assert.deepEqual(next.slice().sort((a, b) => a.number - b.number), canonical);
      if (JSON.stringify(ids(next)) !== JSON.stringify(orders[index])) changed = true;
    }
    assert(changed, 'a new round should refresh the set of participant permutations');
  } finally { await local.mf.dispose(); }
});

for (const legacy of [false, true]) test(`candidate order settings validate, preserve atomicity and lock only real order changes (${legacy ? 'legacy' : 'fresh'})`, async () => {
  const local = await createApp({ legacy });
  try {
    const admin = client(local.mf), anon = client(local.mf); await login(admin); await wines(admin);
    const configure = data => admin('/api/admin/activities/byob', 'PATCH', data);
    const before = await dump(local.db);
    for (const candidateOrder of [null, '', 'shuffle', 1, [], {}]) {
      assert.equal((await settings(admin, { candidateOrder }, 0, '/api', { title: 'Must not save' })).body.code, 'invalid_candidate_order');
      assert.equal((await configure({ candidateOrder, revision: 0 })).body.code, 'invalid_candidate_order');
    }
    assert.equal((await settings(anon, { candidateOrder: 'random' })).status, 401);
    assert.equal((await configure({ candidateOrder: 'random', revision: 1 })).body.code, 'revision_changed');
    assert.deepEqual(await dump(local.db), before);
    assert.equal((await configure({ candidateOrder: 'random', revision: 0 })).status, 200);
    assert.equal((await settings(admin, { candidateOrder: 'registered' })).status, 200);
    assert.equal((await configure({ candidateOrder: 'random', revision: 0 })).status, 200);
    assert.equal((await control(admin, 'open')).status, 200);
    const opened = await dump(local.db);
    assert.equal((await settings(admin, { candidateOrder: 'registered' }, 0, '/api', { title: 'Must not save' })).body.code, 'candidate_order_locked');
    assert.equal((await configure({ candidateOrder: 'registered', title: 'Must not save', revision: 0 })).body.code, 'candidate_order_locked');
    assert.deepEqual(await dump(local.db), opened);
    await assert.rejects(local.db.prepare("UPDATE activities SET candidate_order='registered' WHERE id='byob'").run(), /candidate_order_locked/);
    assert.equal((await settings(admin, { candidateOrder: 'random', votingMethod: 'full', resultVisibility: 'public' }, 0, '/api', { memo: 'Allowed note' })).status, 200);
    assert.equal((await configure({ candidateOrder: 'random', title: 'Allowed title', revision: 0 })).status, 200);
    assert.equal((await control(admin, 'close')).status, 200);
    assert.equal((await settings(admin, { candidateOrder: 'registered' })).body.code, 'candidate_order_locked');
    assert.equal((await reset(admin)).status, 200);
    const resetState = await dump(local.db);
    assert.equal((await settings(admin, { candidateOrder: 'registered' }, 0, '/api', { memo: 'Must not save' })).body.code, 'revision_changed');
    assert.deepEqual(await dump(local.db), resetState);
    assert.equal((await settings(admin, { candidateOrder: 'registered' }, 1)).status, 200);
    assert.equal((await state(admin)).activities[0].candidateOrder, 'registered');
  } finally { await local.mf.dispose(); }
});

for (const legacy of [false, true]) test(`candidate order migration adds only defaulted settings and a lock, preserving every prior row and schema object (${legacy ? 'existing' : 'fresh'})`, async () => {
  const migration = await readFile(new URL('../migrations/0013_candidate_order.sql', import.meta.url), 'utf8');
  assert.equal(await readFile(new URL('../migrations-existing/0024_candidate_order.sql', import.meta.url), 'utf8'), migration);
  const db = new DatabaseSync(':memory:');
  try {
    const folders = legacy ? [new URL('./fixtures/legacy/', import.meta.url), new URL('../migrations-existing/', import.meta.url)] : [new URL('../migrations/', import.meta.url)];
    for (const folder of folders) for (const file of (await readdir(folder)).filter(name => name.endsWith('.sql') && !name.endsWith('_candidate_order.sql')).sort()) db.exec(await readFile(new URL(file, folder), 'utf8'));
    db.exec(`INSERT INTO participants(id,name,name_key) VALUES('preserved-person','Original person','original person');
      INSERT INTO sessions(token_hash,role,participant_id,expires_at,credential_version) VALUES('preserved-session','participant','preserved-person',9999999999999,NULL);
      INSERT INTO candidates(id,number,name,description,object_key,content_type,request_id) VALUES('preserved-wine',7,'Original wine','Original note','original-photo','image/png','original-upload');
      UPDATE event SET title='Original poll',memo='Original memo';
      UPDATE activities SET voting_method='winner',status='open',started_at='2026-11-01' WHERE id='byob';
      INSERT INTO answers VALUES('byob','preserved-person','{"ranking":["preserved-wine"]}','original-time');
      UPDATE activities SET status='closed',published=1 WHERE id='byob';
      INSERT INTO vote_history VALUES('preserved-history',0,'original-time','{"rows":[{"id":"preserved-wine","number":7,"points":1,"object_key":"original-photo"}]}');`);
    if (legacy) db.exec(`UPDATE activities SET status='open',started_at='original-time',actual=100 WHERE id='price';
      INSERT INTO answers VALUES('price','preserved-person','{"price":100}','original-time');`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    const rows = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
    const schema = db.prepare('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all();
    db.exec(migration);
    for (const table of tables) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row })), table === 'activities' ? rows[table].map(row => ({ ...row, candidate_order: 'registered' })) : rows[table]);
    for (const original of schema.filter(row => row.name !== 'activities')) assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(original.name).sql, original.sql);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='byob_candidate_order_lock'").get().n, 1);
    db.exec("UPDATE activities SET candidate_order='registered',title='Old writer still works' WHERE id='byob'");
    assert.throws(() => db.exec("UPDATE activities SET candidate_order='random' WHERE id='byob'"), /candidate_order_locked/);
    db.exec("UPDATE activities SET status='waiting',published=0,started_at=NULL,revision=revision+1 WHERE id='byob'");
    assert.throws(() => db.exec("UPDATE activities SET candidate_order='unsupported' WHERE id='byob'"), /CHECK constraint/);
    db.exec("UPDATE activities SET candidate_order='random' WHERE id='byob'");
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});

const workspaceBundle = await build({ entryPoints: ['worker/workspaces.ts'], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.sql': 'text' } });
const { workspaceSql, ensureWorkspace } = await import(`data:text/javascript;base64,${Buffer.from(workspaceBundle.outputFiles[0].text).toString('base64')}`);

test('closing or resetting during random ordering is rejected by the final activity guard', async () => {
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'], loader: { '.sql': 'text' } });
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  for (const action of ['close', 'reset']) {
    const local = await createApp(), originalDigest = crypto.subtle.digest;
    try {
      const admin = client(local.mf), person = client(local.mf); await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD });
      await admin('/api/admin/candidates', 'POST', { name: 'Guarded wine', requestId: 'guarded-order', revision: 0 });
      assert.equal((await admin('/api/admin/activities/byob', 'PATCH', { revision: 0, candidateOrder: 'random' })).status, 200);
      assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
      const joined = await person('/api/session', 'POST', { name: 'Guarded participant' }), cookie = joined.headers.get('set-cookie').split(';')[0];
      let intercepted = false;
      crypto.subtle.digest = async function (algorithm, bytes) {
        if (!intercepted && new TextDecoder().decode(bytes).startsWith('["owner","byob",0,')) {
          intercepted = true;
          const response = action === 'close'
            ? await admin('/api/admin/activities/byob/state', 'POST', { action: 'close', revision: 0 })
            : await admin('/api/admin/activities/byob/reset', 'POST', { confirm: 'reset', expectedRevision: 0 });
          assert.equal(response.status, 200);
        }
        return originalDigest.call(this, algorithm, bytes);
      };
      const response = await worker.fetch(new Request('https://vote.test/api/activities/byob', { headers: { Cookie: cookie } }), { DB: local.db });
      assert(intercepted); assert.equal(response.status, action === 'close' ? 403 : 409);
      assert.equal((await response.json()).code, action === 'close' ? 'activity_unavailable' : 'revision_changed');
    } finally { crypto.subtle.digest = originalDigest; await local.mf.dispose(); }
  }
});

test('old namespaces upgrade concurrently without rewriting data or adding steady-state schema queries', async () => {
  const local = await createApp();
  try {
    const workspace = { slug: 'old-workspace', namespace: `m_${'a'.repeat(32)}` }, other = { slug: 'other-workspace', namespace: `m_${'b'.repeat(32)}` };
    for (const file of ['0001_initial.sql', '0004_candidate_description.sql', '0006_participant_entries.sql', '0008_event_memo.sql', '0009_result_audience.sql', '0011_candidate_photo_replace.sql']) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map(value => value.trim()).filter(value => value && !/^PRAGMA\b/i.test(value))) await local.db.prepare(workspaceSql(statement, workspace.namespace)).run();
    }
    const prefix = workspace.namespace + '_';
    await local.db.batch([
      local.db.prepare(`INSERT INTO ${prefix}participants VALUES('old-person','Original person','original person')`),
      local.db.prepare(`INSERT INTO ${prefix}sessions VALUES('old-session','participant','old-person',9999999999999,NULL)`),
      local.db.prepare(`INSERT INTO ${prefix}candidates(id,number,name,description,object_key,content_type,request_id) VALUES('old-wine',4,'Original wine','Original note','original-photo','image/png','old-upload')`),
      local.db.prepare(`UPDATE ${prefix}activities SET status='open',started_at='original-time'`),
      local.db.prepare(`INSERT INTO ${prefix}answers VALUES('byob','old-person','{"ranking":["old-wine"]}','original-time')`),
      local.db.prepare(`UPDATE ${prefix}activities SET status='closed',published=1`),
      local.db.prepare(`INSERT INTO ${prefix}vote_history VALUES('old-history',0,'original-time','{"rows":[{"object_key":"original-photo","points":1}]}')`)
    ]);
    const tables = ['event', 'activities', 'participants', 'sessions', 'candidates', 'answers', 'vote_history', 'participant_entries', 'participant_round_entries'];
    const dump = async namespace => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await local.db.prepare(`SELECT * FROM ${namespace}${table} ORDER BY rowid`).all()).results])));
    const before = await dump(prefix), rootBefore = await dump('');
    await ensureWorkspace({ DB: local.db }, other);
    await local.db.prepare(`UPDATE ${other.namespace}_activities SET candidate_order='random'`).run();
    const otherBefore = await dump(other.namespace + '_');
    await Promise.all(Array.from({ length: 4 }, () => ensureWorkspace({ DB: local.db }, workspace)));
    assert.deepEqual(await dump(prefix), { ...before, activities: before.activities.map(row => ({ ...row, candidate_order: 'registered' })) });
    assert.deepEqual(await dump(''), rootBefore); assert.deepEqual(await dump(other.namespace + '_'), otherBefore);
    const queriedTables = [];
    const observed = { prepare(sql) { const statement = local.db.prepare(sql); return { bind(...values) { queriedTables.push(values[0]); return statement.bind(...values); } }; }, batch() { assert.fail('ready workspace must not write'); } };
    await ensureWorkspace({ DB: observed }, workspace);
    assert.equal(queriedTables.length, 6); assert.equal(queriedTables.filter(name => name === prefix + 'activities').length, 1);
    await assert.rejects(local.db.prepare(`UPDATE ${prefix}activities SET candidate_order='random'`).run(), /candidate_order_locked/);
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await local.mf.dispose(); }
});
