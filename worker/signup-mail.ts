import { connect } from 'node:tls';
import { createTransport } from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';

type MailEnv = { DB: D1Database; PUBLIC_ORIGIN?: string; SUPERADMIN_EMAIL?: string; SMTP_CONFIG?: string };
type Notice = { member_id: string; email: string; attempts: number };

export function mailConfiguration(env: MailEnv) {
  const origin = new URL(env.PUBLIC_ORIGIN ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid mail configuration');
  const smtp = JSON.parse(env.SMTP_CONFIG ?? '{}');
  if (!smtp || smtp.secure !== true || typeof smtp.host !== 'string' || !smtp.host || /\s/.test(smtp.host) || !Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535 || typeof smtp.user !== 'string' || !smtp.user || typeof smtp.pass !== 'string' || !smtp.pass || typeof smtp.from !== 'string' || !smtp.from || /[\r\n]/.test(smtp.from)) throw new Error('TLS mail configuration required');
  return { origin, smtp };
}
function transport(smtp: ReturnType<typeof mailConfiguration>['smtp']) {
  return createTransport({
    host: smtp.host, port: smtp.port, secure: true, auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, disableFileAccess: true, disableUrlAccess: true,
    // Connect by hostname so Workers preserves the provider's TLS server name.
    getSocket(_options, done) {
      const socket = connect({ host: smtp.host, port: smtp.port, servername: smtp.host, rejectUnauthorized: true });
      const timer = setTimeout(() => socket.destroy(new Error('Mail connection timed out')), 10000);
      function finish(error?: Error) {
        clearTimeout(timer);
        socket.off('error', finish);
        socket.off('close', closed);
        socket.off('secureConnect', ready);
        if (error) { socket.destroy(); done(error); }
        else done(null, { connection: socket, secured: true });
      }
      function closed() { finish(new Error('Mail connection closed')); }
      function ready() { finish(socket.authorized ? undefined : new Error('Unverified TLS connection')); }
      socket.once('error', finish).once('close', closed).once('secureConnect', ready);
    }
  } satisfies SMTPTransportOptions);
}
async function sendNotice(env: MailEnv, notice: Notice) {
  const recipient = env.SUPERADMIN_EMAIL?.trim();
  if (!recipient || /[\r\n,;]/.test(recipient)) throw new Error('Invalid mail configuration');
  const { origin, smtp } = mailConfiguration(env), mailer = transport(smtp);
  try {
    const result = await mailer.sendMail({
      from: smtp.from, to: recipient, subject: '와인 인기투표 회원 가입 승인 요청',
      messageId: `<byob-signup-${notice.member_id}@${origin.hostname}>`,
      text: `${notice.email} 님이 회원 가입을 신청했습니다.\n\n아래 링크로 로그인한 뒤 가입 승인 메뉴에서 신청을 확인해 주세요.\n${new URL('/admin?settings=approvals', origin).href}`
    });
    if (result.accepted.length !== 1 || result.rejected.length) throw new Error('Mail was not accepted');
  } finally { mailer.close(); }
}

export async function sendPasswordReset(env: MailEnv, notice: { email: string; token: string }) {
  const { origin, smtp } = mailConfiguration(env), mailer = transport(smtp);
  try {
    const result = await mailer.sendMail({
      from: smtp.from, to: notice.email, subject: '와인 인기투표 비밀번호 재설정',
      text: `아래 링크에서 새 비밀번호를 설정해 주세요. 이 링크는 30분 동안 한 번만 사용할 수 있습니다.\n${new URL('/#reset=' + notice.token, origin).href}\n\n요청하지 않았다면 이 메일을 무시해 주세요.`
    });
    if (result.accepted.length !== 1 || result.rejected.length) throw new Error('Mail was not accepted');
  } finally { mailer.close(); }
}

export async function sendBuildFailureNotice(env: MailEnv, notice: { buildUuid: string; accountId: string }) {
  const recipient = env.SUPERADMIN_EMAIL?.trim();
  if (!recipient || /[\r\n,;]/.test(recipient)) throw new Error('Invalid mail configuration');
  const { origin, smtp } = mailConfiguration(env), mailer = transport(smtp);
  try {
    const result = await mailer.sendMail({
      from: smtp.from, to: recipient, subject: '[BYOB] 운영 배포 실패',
      // shortcut: SMTP acceptance and Queue acknowledgement are not atomic; stable Message-ID groups redelivery, add an outbox if duplicates become a problem.
      messageId: `<byob-deploy-failure-${notice.buildUuid}@${origin.hostname}>`,
      text: `와인 인기투표(BYOB)의 운영 빌드 또는 배포가 실패했습니다.\nWorker: vinolog-vote\n저장소: binalee0010/byob-wine-vote\n브랜치: main\n\n아래 Cloudflare 빌드 화면에서 실패 원인을 확인해 주세요.\nhttps://dash.cloudflare.com/${notice.accountId}/workers/services/view/vinolog-vote/production/builds/${notice.buildUuid}`
    });
    if (result.accepted.length !== 1 || result.rejected.length) throw new Error('Mail was not accepted');
  } finally { mailer.close(); }
}

// Each claim is conditional so signup and the scheduled retry can safely overlap.
export async function retryPendingNotices(env: MailEnv, memberId?: string, deliver = sendNotice) {
  if (!env.SUPERADMIN_EMAIL) return;
  const due = "sent_at IS NULL AND next_attempt_at<=? AND lease_until<=? AND EXISTS(SELECT 1 FROM members m WHERE m.id=member_notice_outbox.member_id AND m.status='pending')";
  const now = Date.now();
  const query = env.DB.prepare(`SELECT member_id,email,attempts FROM member_notice_outbox WHERE ${due} ${memberId ? 'AND member_id=?' : ''} ORDER BY next_attempt_at,member_id LIMIT 3`);
  const rows = await query.bind(now, now, ...(memberId ? [memberId] : [])).all<Notice>();
  for (const row of rows.results) {
    const lease = crypto.randomUUID();
    const at = Date.now();
    const claim = await env.DB.prepare(`UPDATE member_notice_outbox SET lease_until=?,lease_token=?,attempts=attempts+1 WHERE member_id=? AND ${due}`)
      .bind(at + 90000, lease, row.member_id, at, at).run();
    if (!claim.meta.changes) continue;
    let accepted = false;
    try { await deliver(env, row); accepted = true; } catch { /* Retry without storing SMTP credentials or provider messages. */ }
    const next = Date.now() + Math.min(24 * 3600000, 300000 * 2 ** Math.min(row.attempts, 9));
    await env.DB.prepare('UPDATE member_notice_outbox SET sent_at=?,next_attempt_at=?,last_error=?,lease_until=0,lease_token=NULL WHERE member_id=? AND lease_token=?')
      .bind(accepted ? Date.now() : null, next, accepted ? null : 'delivery_failed', row.member_id, lease).run();
  }
}
