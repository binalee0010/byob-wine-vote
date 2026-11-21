import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createApp, client, TEST_PASSWORD, photo } from './harness.mjs';

const config = '/api/admin/activities/byob';
const detail = '/api/activities/byob';
const results = '/api/results/byob';
const control = (admin, action, revision) => admin(`${config}/state`, 'POST', { action, revision });
const vote = (participant, ranking, revision) => participant(`${detail}/answer`, 'PUT', { ranking, revision });
const getAdmin = async admin => {
  const response = await admin('/api/admin/state');
  assert.equal(response.status, 200);
  return response.body;
};
const upload = async (admin, name, revision = 0) => {
  const form = photo(name);
  form.set('revision', String(revision));
  const response = await admin('/api/admin/candidates', 'POST', form);
  assert.equal(response.status, 200);
  return response.body.candidate;
};
const addName = async (admin, name, revision = 0) => {
  const response = await admin('/api/admin/candidates', 'POST', { name, requestId: crypto.randomUUID(), revision });
  assert.equal(response.status, 200);
  assert.equal(response.body.candidate.photoUrl, null);
  return response.body.candidate;
};

test('individual BYOB configuration rejects an admin session revoked just before the write', async () => {
  const local = await createApp();
  try {
    const { mf, db } = local;
    const admin = client(mf);
    const login = await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD });
    assert.equal(login.status, 200);
    const candidateSettings = () => db.prepare("SELECT voting_method,rank_points FROM activities WHERE id='byob'").first();
    const before = await candidateSettings();
    const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
    const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
    let revoked = false;
    const DB = { prepare: sql => {
      const statement = db.prepare(sql);
      if (!sql.startsWith('UPDATE activities') || !sql.includes('voting_method=?')) return statement;
      return { bind: (...args) => ({ run: async () => {
        const logout = await admin('/api/admin/session', 'DELETE');
        assert.equal(logout.status, 200);
        revoked = true;
        return statement.bind(...args).run();
      } }) };
    } };
    const response = await worker.fetch(new Request(`https://vote.test${config}`, {
      method: 'PATCH',
      headers: { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: 'https://vote.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ votingMethod: 'top2', revision: 0 })
    }), { DB, PASSWORD_VERIFIER: await mf.getDurableObjectNamespace('PASSWORD_VERIFIER') });
    assert.equal(revoked, true);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'unauthorized');
    assert.deepEqual(await candidateSettings(), before);
  } finally { await local.mf.dispose(); }
});

test('winner and top-two voting validate ballots, share the correct totals, and preserve settings after reset', async () => {
  const canonical = 'https://vote.example.test';
  const local = await createApp({ publicOrigin: canonical });
  try {
    const admin = client(local.mf), anon = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    assert.equal((await getAdmin(admin)).participantUrl, canonical + '/');
    assert.equal((await anon('/api/bootstrap')).body.activities[0].votingMethod, 'full');
    assert.equal((await anon(config, 'PATCH', { votingMethod: 'winner', revision: 0 })).status, 401);
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'winner', revision: 0 }, { headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'unknown', revision: 0 })).body.code, 'invalid_voting_method');
    const registration = await admin('/api/admin/participants', 'POST', { names: ['방식 검증 첫째', '방식 검증 둘째'] });
    assert.equal(registration.status, 200);
    const participants = registration.body.created.map(() => client(local.mf));
    for (const [i, person] of registration.body.created.entries()) {
      assert.equal((await participants[i]('/api/session', 'POST', { name: person.name })).status, 200);
    }
    const [first, second] = participants;
    const a = await addName(admin, '검증 A');
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'top2', revision: 0 })).status, 200);
    assert.equal((await control(admin, 'open', 0)).status, 409);
    assert.equal((await getAdmin(admin)).activities[0].started, false);
    const b = await upload(admin, '검증 B');
    const c = await addName(admin, '검증 C');
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'winner', revision: 0 })).status, 200);
    assert.equal((await control(admin, 'open', 0)).status, 200);
    const winnerDetail = await first(detail);
    assert.equal(winnerDetail.body.activity.votingMethod, 'winner');
    assert.equal(winnerDetail.body.selectionCount, 1);
    assert.equal((await vote(anon, [a.id], 0)).status, 401);
    for (const invalid of [[], [a.id, b.id], ['foreign-id']]) {
      const rejected = await vote(first, invalid, 0);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.code, 'invalid_ranking');
    }
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'top2', revision: 0 })).body.code, 'voting_method_locked');
    await assert.rejects(local.db.prepare("UPDATE activities SET voting_method='top2' WHERE id='byob'").run(), /voting_method_locked/);
    assert.equal((await vote(first, [c.id], 0)).status, 200);
    assert.equal((await vote(first, [a.id], 0)).status, 200);
    assert.equal((await vote(second, [b.id], 0)).status, 200);
    const winnerState = await getAdmin(admin);
    assert.equal(winnerState.answers.byob.length, 2);
    assert.deepEqual(winnerState.byobResults.map(row => [row.id, row.votes, row.rank]), [[a.id, 1, 1], [b.id, 1, 1], [c.id, 0, 3]]);
    assert(winnerState.byobResults.every(row => !Object.hasOwn(row, 'points')));
    assert.equal((await anon(results)).status, 403);
    assert.equal((await control(admin, 'close', 0)).status, 200);
    assert.equal((await vote(first, [b.id], 0)).status, 409);
    assert.equal((await anon(results)).status, 403);
    assert.equal((await control(admin, 'publish', 0)).status, 200);
    const winnerResult = await anon(results);
    assert.equal(winnerResult.body.votingMethod, 'winner');
    assert.deepEqual(winnerResult.body.rows, winnerState.byobResults);
    assert(!JSON.stringify(winnerResult.body).includes(registration.body.created[0].name));

    assert.equal((await admin(`${config}/reset`, 'POST', { confirm: 'reset', expectedRevision: 0 })).status, 200);
    const reset = await getAdmin(admin);
    assert.equal(reset.activities[0].votingMethod, 'winner');
    assert.deepEqual(reset.participants, winnerState.participants);
    assert.deepEqual(reset.candidates, winnerState.candidates);
    assert.deepEqual(reset.answers.byob, []);
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'top2', revision: 0 })).body.code, 'revision_changed');
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'top2', revision: 1 })).status, 200);
    assert.equal((await control(admin, 'open', 1)).status, 200);
    const top2Detail = await first(detail);
    assert.equal(top2Detail.body.activity.votingMethod, 'custom');
    assert.deepEqual(top2Detail.body.activity.rankPoints, [3, 1]);
    assert.equal(top2Detail.body.selectionCount, 2);
    assert.equal(top2Detail.body.mine, null);
    assert.equal((await vote(first, [a.id, b.id], 0)).body.code, 'revision_changed');
    for (const invalid of [[a.id], [a.id, a.id], [a.id, b.id, c.id], [a.id, 'foreign-id']]) {
      assert.equal((await vote(first, invalid, 1)).body.code, 'invalid_ranking');
    }
    assert.equal((await first(`${detail}/answer`, 'PUT', { ranking: [a.id, b.id], revision: 1, points: 999 })).body.code, 'invalid_ranking');
    assert.equal((await vote(first, [a.id, b.id], 1)).status, 200);
    await assert.rejects(local.db.prepare("UPDATE answers SET payload=? WHERE activity_id='byob'")
      .bind(JSON.stringify({ ranking: [a.id] })).run(), /candidate_missing/);
    assert.equal((await vote(second, [c.id, a.id], 1)).status, 200);
    const top2State = await getAdmin(admin);
    assert.deepEqual(top2State.byobResults.map(row => [row.id, row.points, row.rank]), [[a.id, 4, 1], [c.id, 3, 2], [b.id, 1, 3]]);
    assert(top2State.byobResults.every(row => !Object.hasOwn(row, 'votes')));
    assert.equal((await control(admin, 'close', 1)).status, 200);
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'full', revision: 1 })).body.code, 'voting_method_locked');
    assert.equal((await control(admin, 'publish', 1)).status, 200);
    const top2Result = await anon(results);
    assert.equal(top2Result.body.votingMethod, 'custom');
    assert.equal(top2Result.body.revision, 1);
    assert.deepEqual(top2Result.body.rows, top2State.byobResults);
  } finally { await local.mf.dispose(); }
});

test('opening with one candidate cannot race with saving the top-two method', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    await upload(admin, '동시성 검증 와인');
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'winner', revision: 0 })).status, 200);
    const [changed, opened] = await Promise.all([
      admin(config, 'PATCH', { votingMethod: 'top2', revision: 0 }), control(admin, 'open', 0)
    ]);
    assert.deepEqual([changed.status, opened.status].sort(), [200, 409]);
    const activity = (await getAdmin(admin)).activities[0];
    assert.deepEqual([activity.votingMethod, activity.status], opened.status === 200 ? ['winner', 'open'] : ['custom', 'waiting']);
  } finally { await local.mf.dispose(); }
});

test('custom rank points are validated, locked, and totaled in order; full awards the last candidate one point', async () => {
  const local = await createApp();
  try {
    const admin = client(local.mf), first = client(local.mf), second = client(local.mf), anon = client(local.mf);
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const settings = (patch, event) => admin('/api/admin/settings', 'PATCH', { event, activities: [{ id: 'byob', revision: 0, ...patch }] });
    for (const rankPoints of [[], [0, 0], [1, -1], [1.5], ['5'], [1_000_001], Array(101).fill(1)]) {
      assert.equal((await settings({ votingMethod: 'custom', rankPoints })).body.code, 'invalid_rank_points');
    }
    assert.equal((await settings({ rankPoints: [5, 2, 0] })).body.code, 'voting_method_changed');
    assert.equal((await settings({ votingMethod: 'full', rankPoints: [5, 2, 0] })).body.code, 'invalid_rank_points');
    assert.equal((await settings({ votingMethod: 'custom', rankPoints: [0, 5, 2] })).status, 200);
    const candidates = [await addName(admin, '배점 A'), await upload(admin, '배점 B')];
    assert.equal((await control(admin, 'open', 0)).status, 409);
    candidates.push(await upload(admin, '배점 C'), await addName(admin, '배점 D'));
    const [a, b, c, d] = candidates.map(candidate => candidate.id);
    assert.equal((await settings({ rankPoints: [5, 2, 0] })).status, 200);
    assert.deepEqual((await anon('/api/bootstrap')).body.activities[0].rankPoints, [5, 2, 0]);
    assert.equal((await control(admin, 'open', 0)).status, 200);
    const before = await getAdmin(admin);
    assert.equal((await settings({ rankPoints: [1] }, { title: '변경되면 안 되는 이름' })).body.code, 'voting_method_locked');
    assert.deepEqual((await getAdmin(admin)).event, before.event);
    assert.equal((await admin(config, 'PATCH', { revision: 0, rankPoints: [1] })).body.code, 'voting_method_locked');
    await assert.rejects(local.db.prepare("UPDATE activities SET rank_points='[1]' WHERE id='byob'").run(), /voting_method_locked/);
    assert.equal((await first('/api/session', 'POST', { name: '배점 검증 1' })).status, 200);
    assert.equal((await second('/api/session', 'POST', { name: '배점 검증 2' })).status, 200);
    assert.equal((await first(detail)).body.selectionCount, 3);
    for (const invalid of [[a, b], [a, b, c, d], [a, b, a], [a, b, 'foreign-id']]) {
      assert.equal((await vote(first, invalid, 0)).body.code, 'invalid_ranking');
    }
    assert.equal((await vote(first, [a, b, c], 0)).status, 200);
    assert.equal((await vote(first, [b, a, d], 0)).status, 200);
    assert.deepEqual((await first(detail)).body.mine, { ranking: [b, a, d] });
    assert.equal((await vote(second, [a, d, b], 0)).status, 200);
    assert.equal((await anon(results)).status, 403);
    assert.equal((await control(admin, 'close', 0)).status, 200);
    assert.equal((await vote(first, [a, c, b], 0)).body.code, 'activity_closed');
    assert.equal((await control(admin, 'publish', 0)).status, 200);
    const published = await anon(results);
    assert.equal(published.body.votingMethod, 'custom');
    assert.deepEqual(published.body.rows.map(row => [row.id, row.points, row.rank]), [[a, 7, 1], [b, 5, 2], [d, 2, 3], [c, 0, 4]]);
    assert.deepEqual(published.body.rows.filter(row => row.photoUrl === null).map(row => row.id), [a, d]);
    assert.deepEqual((await getAdmin(admin)).byobResults, published.body.rows);

    assert.equal((await admin(`${config}/reset`, 'POST', { confirm: 'reset', expectedRevision: 0 })).status, 200);
    const reset = (await getAdmin(admin)).activities[0];
    assert.deepEqual([reset.votingMethod, reset.rankPoints], ['custom', [5, 2, 0]]);
    assert.equal((await admin(config, 'PATCH', { revision: 1, votingMethod: 'full' })).status, 200);
    for (const name of ['배점 E', '배점 F', '배점 G']) candidates.push(await upload(admin, name, 1));
    assert.equal((await control(admin, 'open', 1)).status, 200);
    assert.equal((await vote(first, candidates.map(candidate => candidate.id), 1)).status, 200);
    assert.equal((await control(admin, 'close', 1)).status, 200);
    assert.equal((await control(admin, 'publish', 1)).status, 200);
    assert.deepEqual((await anon(results)).body.rows.map(row => row.points), [7, 6, 5, 4, 3, 2, 1]);
  } finally { await local.mf.dispose(); }
});

test('ranked names join freely and concurrent normalized names share one ballot across sessions', async () => {
  const local = await createApp();
  try {
    const first = client(local.mf), second = client(local.mf), admin = client(local.mf);
    for (const name of ['', '　　', '가'.repeat(81), null]) {
      assert.equal((await first('/api/session', 'POST', { name })).status, 400);
    }
    const [one, two] = await Promise.all([
      first('/api/session', 'POST', { name: ' Ａlice　테스트 ' }),
      second('/api/session', 'POST', { name: 'alice    테스트' })
    ]);
    assert.deepEqual([one.status, two.status], [200, 200]);
    assert.deepEqual(one.body.participant, two.body.participant);
    assert.match(one.body.participant.name, /^alice 테스트$/i);
    assert.notEqual(one.headers.get('set-cookie'), two.headers.get('set-cookie'));
    assert.equal((await admin('/api/admin/login', 'POST', { password: TEST_PASSWORD })).status, 200);
    const joined = await getAdmin(admin);
    assert.deepEqual(joined.participants, [one.body.participant]);
    assert.equal(joined.rosterRevision, 1);
    const a = await upload(admin, '자유 참여 A'), b = await upload(admin, '자유 참여 B');
    assert.equal((await admin(config, 'PATCH', { votingMethod: 'winner', revision: 0 })).status, 200);
    assert.equal((await control(admin, 'open', 0)).status, 200);
    assert.equal((await vote(first, [a.id], 0)).status, 200);
    assert.deepEqual((await second(detail)).body.mine, { ranking: [a.id] });
    assert.equal((await vote(second, [b.id], 0)).status, 200);
    assert.deepEqual((await first(detail)).body.mine, { ranking: [b.id] });
    const state = await getAdmin(admin);
    assert.equal(state.answers.byob.length, 1);
    assert.deepEqual(state.byobResults.map(row => [row.id, row.votes]), [[b.id, 1], [a.id, 0]]);
    const publicBootstrap = await client(local.mf)('/api/bootstrap');
    assert.equal(publicBootstrap.body.participant, null);
    assert(!JSON.stringify(publicBootstrap.body).includes(one.body.participant.name));
    assert.equal((await admin(`${config}/reset`, 'POST', { confirm: 'reset', expectedRevision: 0 })).status, 200);
    const rejoined = await client(local.mf)('/api/session', 'POST', { name: 'ALICE 테스트' });
    assert.deepEqual(rejoined.body.participant, one.body.participant);
    assert.equal((await getAdmin(admin)).rosterRevision, 1);
    assert.equal((await first('/api/bootstrap')).body.participant.submitted.byob, false);
  } finally { await local.mf.dispose(); }
});
