import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const compiled = await build({ entryPoints: [fileURLToPath(new URL('../worker/workspaces.ts', import.meta.url))], bundle: true, write: false,
  format: 'esm', platform: 'node', loader: { '.sql': 'text' } });
const { workspaceSql, workspaceDatabase, workspaceEnv, workspacePhotoKey, ensureWorkspace } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const workspace = { slug: 'synthetic-member', namespace: `m_${'a'.repeat(32)}` };
const other = { slug: 'other-member', namespace: `m_${'b'.repeat(32)}` };
const owner = { slug: 'owner', namespace: null };
const prefix = workspace.namespace + '_';

function d1(sqlite) {
  return {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first(column) { const row = sqlite.prepare(sql).get(...bindings); return row ? column ? row[column] : { ...row } : null; },
        async run() { const result = sqlite.prepare(sql).run(...bindings); return { success: true, meta: { changes: result.changes }, results: [] }; }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
}

test('fixed SQL identifiers are isolated without changing values, JSON paths, comments or aliases', () => {
  assert.equal(workspaceSql(`SELECT candidates.id,'candidates','byob','$.answers',"participants".id FROM candidates -- answers\n/* event */ JOIN "participants" ON participants.id=?`, workspace.namespace),
    `SELECT ${prefix}candidates.id,'candidates','byob','$.answers',"${prefix}participants".id FROM ${prefix}candidates -- answers\n/* event */ JOIN "${prefix}participants" ON ${prefix}participants.id=?`);
  for (const namespace of ['owner', 'm_bad', `m_${'a'.repeat(32)};DROP TABLE event`]) assert.throws(() => workspaceSql('SELECT * FROM event', namespace));
});

test('workspace provisioning preserves owner schema and rows, namespaces all constraints and is idempotent', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    for(const file of ['0002_members.sql','0003_password_reset.sql','0004_candidate_description.sql','0005_member_polls.sql','0006_participant_entries.sql','0007_poll_deletion.sql'])sqlite.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    sqlite.exec("INSERT INTO participants VALUES('owner-person','Original person','original person')");
    const initial = sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    const db = d1(sqlite);
    await ensureWorkspace({ DB: db }, workspace);
    await ensureWorkspace({ DB: db }, workspace);
    await ensureWorkspace({ DB: db }, other);
    await ensureWorkspace({ DB: db }, owner);
    const scoped = workspaceDatabase(db, workspace);
    await scoped.prepare("INSERT INTO participants VALUES('person','Private person','private person')").run();
    assert.equal((await scoped.prepare('SELECT count(*) AS n FROM participants').first()).n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM participants').get().n, 1);
    assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM ${other.namespace}_participants`).get().n, 0);
    assert.equal(sqlite.prepare(`SELECT id FROM ${prefix}activities`).get().id, 'byob');
    const originalNames = new Set(initial.map(row => row.name));
    assert.deepEqual(sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().filter(row => originalNames.has(row.name)), initial);
    assert.equal(sqlite.prepare(`SELECT roster_revision FROM ${prefix}event`).get().roster_revision, 1);
    assert.equal(sqlite.prepare('SELECT roster_revision FROM event').get().roster_revision, 1);
    await assert.rejects(scoped.prepare("INSERT INTO sessions VALUES('bad','admin',NULL,9999999999999,'stale')").run(), /credential_changed/);
    await scoped.prepare("INSERT INTO candidates(id,number,name,object_key,content_type,request_id) VALUES('wine',1,'Wine','','','upload-one')").run();
    await scoped.prepare("UPDATE activities SET status='open',started_at='2026-01-01' WHERE id='byob'").run();
    await assert.rejects(scoped.prepare("DELETE FROM candidates WHERE id='wine'").run(), /candidates_locked/);
    await scoped.prepare("INSERT INTO answers VALUES('byob','person','{\"ranking\":[\"wine\"]}','today')").run();
    await scoped.prepare("UPDATE activities SET status='waiting',published=0,started_at=NULL,revision=revision+1,full_reset_revision=full_reset_revision+1 WHERE id='byob'").run();
    for (const table of ['participants', 'candidates', 'answers']) assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM ${prefix}${table}`).get().n, 0);
    assert.equal(sqlite.prepare('SELECT id FROM participants').get().id, 'owner-person');
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { sqlite.close(); }
});

test('photos and cookies have separate workspace boundaries including queued cross-namespace keys', async () => {
  const touched = [];
  const env = { DB: {}, PHOTOS: { async get(key) { touched.push(key); }, async put(key) { touched.push(key); }, async delete(keys) { touched.push(keys); } } };
  const scoped = workspaceEnv(env, workspace), scopedOther = workspaceEnv(env, other), scopedOwner = workspaceEnv(env, owner);
  assert.notEqual(scoped.PARTICIPANT_SESSION_COOKIE, scopedOther.PARTICIPANT_SESSION_COOKIE);
  assert.notEqual(scoped.ADMIN_SESSION_COOKIE, scopedOther.ADMIN_SESSION_COOKIE);
  const key = workspacePhotoKey(workspace, 'candidates/photo');
  await scoped.PHOTOS.put(key, new Uint8Array());
  await scoped.PHOTOS.get(key);
  await scoped.PHOTOS.delete([key]);
  for (const invalid of ['candidates/owner-photo', workspacePhotoKey(other, 'candidates/photo')]) {
    assert.throws(() => scoped.PHOTOS.get(invalid), /outside workspace/);
    assert.throws(() => scoped.PHOTOS.delete([key, invalid]), /outside workspace/);
  }
  assert.throws(() => scopedOwner.PHOTOS.delete(key), /outside workspace/);
  assert.equal(touched.length, 3);
  assert.equal(workspacePhotoKey(owner, 'candidates/original'), 'candidates/original');
});
