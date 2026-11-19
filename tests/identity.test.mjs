import test from 'node:test';
import assert from 'node:assert/strict';
import { client, createApp, TEST_PASSWORD } from './harness.mjs';

test('rendered participant mismatch cannot overwrite another participant ballot', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf), person = client(local.mf), anon = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const ids = [];
    for (const name of ['첫 와인', '둘째 와인']) {
      const added = await admin('/api/admin/candidates', 'POST', { name, requestId: crypto.randomUUID(), revision: 0 });
      assert.equal(added.status, 200);
      ids.push(added.body.candidate.id);
    }
    assert.equal((await admin('/api/admin/activities/byob/state', 'POST', { action: 'open', revision: 0 })).status, 200);
    const joinedA = await person('/api/session', 'POST', { name: '이전 화면 이름' });
    const firstId = joinedA.body.participant.id;
    assert.equal((await person('/api/activities/byob/answer', 'PUT', {
      ranking: ids, revision: 0, expectedParticipantId: firstId
    })).status, 200);
    const before = (await admin('/api/admin/state')).body.answers;
    const joinedB = await person('/api/session', 'POST', { name: '현재 쿠키 이름' });
    const secondId = joinedB.body.participant.id;
    assert.notEqual(firstId, secondId);
    const stale = await person('/api/activities/byob/answer', 'PUT', {
      ranking: ids, revision: 0, expectedParticipantId: firstId
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'participant_changed');
    assert.equal((await person('/api/activities/byob')).body.mine, null);
    assert.deepEqual((await admin('/api/admin/state')).body.answers, before);
    for (const invalid of [null, '', 1, 'x'.repeat(81)]) {
      assert.equal((await person('/api/activities/byob/answer', 'PUT', {
        ranking: ids, revision: 0, expectedParticipantId: invalid
      })).status, 400);
    }
    assert.equal((await anon('/api/activities/byob/answer', 'PUT', {
      ranking: ids, revision: 0, expectedParticipantId: secondId
    })).status, 401);
    assert.equal((await person('/api/activities/byob/answer', 'PUT', {
      ranking: ids.toReversed(), revision: 0, expectedParticipantId: secondId
    })).status, 200);
    assert.equal((await person('/api/activities/byob/answer', 'PUT', { ranking: ids, revision: 0 })).status, 200);
    const saved = (await local.db.prepare("SELECT payload FROM answers WHERE activity_id='byob' AND participant_id=?").bind(secondId).first()).payload;
    assert.deepEqual(JSON.parse(saved), { ranking: ids });
    assert.equal((await local.db.prepare("SELECT count(*) AS n FROM answers WHERE activity_id='byob'").first()).n, 2);
  } finally { await local.mf.dispose(); }
});