import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('fresh schema has only the BYOB activity, no participant data and valid constraints', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    assert.deepEqual(db.prepare('SELECT id FROM activities').all().map(row => row.id), ['byob']);
    for (const table of ['participants', 'sessions', 'candidates', 'answers', 'vote_history', 'candidate_photo_cleanup', 'admin_credentials']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});
