import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './harness.mjs';
import { retryPendingNotices } from '../worker/signup-mail.ts';

test('mail outbox retries failed delivery, claims once across concurrent runners and skips reviewed requests', async () => {
  const { mf, db } = await createApp();
  try {
    const id = 'a'.repeat(32), email = 'mail-test@example.test';
    await db.prepare("INSERT INTO members(id,email,role,status,workspace_slug,namespace,password_hash,credential_version,created_at) VALUES(?,?,'member','pending',?,?,?, ?,1)")
      .bind(id, email, id, 'm_' + id, 'fixture', 'v1').run();
    await db.prepare('INSERT INTO member_notice_outbox(member_id,email) VALUES(?,?)').bind(id,email).run();
    const env = { DB: db, SUPERADMIN_EMAIL: 'owner@example.test' };
    await retryPendingNotices(env, id, async () => { throw new Error('synthetic temporary failure'); });
    const state = () => db.prepare('SELECT * FROM member_notice_outbox WHERE member_id=?').bind(id).first();
    const failed = await state();
    assert.equal(failed.sent_at, null);
    assert.equal(failed.last_error, 'delivery_failed');
    assert(failed.next_attempt_at > Date.now());
    await db.prepare('UPDATE member_notice_outbox SET next_attempt_at=0 WHERE member_id=?').bind(id).run();
    let sends = 0;
    const deliver = async (settings, row) => { assert.equal(settings.SUPERADMIN_EMAIL, 'owner@example.test'); assert.equal(row.email,email); sends++; };
    await Promise.all([retryPendingNotices(env, id, deliver), retryPendingNotices(env, undefined, deliver)]);
    assert.equal(sends,1);
    assert((await state()).sent_at);
    await db.prepare('UPDATE members SET status=? WHERE id=?').bind('rejected',id).run();
    await db.prepare('UPDATE member_notice_outbox SET sent_at=NULL,next_attempt_at=0 WHERE member_id=?').bind(id).run();
    await retryPendingNotices(env, id, deliver);
    assert.equal(sends,1);
  } finally { await mf.dispose(); }
});
