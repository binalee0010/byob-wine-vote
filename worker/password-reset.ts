import type { Env } from './index';
import { mailConfiguration, sendPasswordReset } from './signup-mail';

const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

export class PasswordResetError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code: string) { super(message); this.status = status; this.code = code; }
}
function service(env: Env) { return env.PASSWORD_VERIFIER.get(env.PASSWORD_VERIFIER.idFromName('admin-password')); }
const invalid = () => new PasswordResetError(400, '유효하지 않거나 만료된 링크입니다. 비밀번호 재설정을 다시 요청해 주세요.', 'invalid_reset_token');

export async function requestPasswordReset(env: Env, address: string, deliver = sendPasswordReset) {
  // Validate before lookup so configuration errors cannot reveal registered addresses.
  try { mailConfiguration(env); } catch { throw new PasswordResetError(503, '메일 설정을 확인한 뒤 다시 요청해 주세요.', 'mail_unavailable'); }
  const owner = env.SUPERADMIN_EMAIL!.trim().toLowerCase();
  const response = await service(env).fetch('https://password.internal/state');
  if (!response.ok) throw new PasswordResetError(503, '비밀번호 설정을 확인한 뒤 다시 요청해 주세요.', 'admin_unconfigured');
  const credential = await response.json() as { version: string };
  let id: string, role: 'owner' | 'member', version: string;
  if (address === owner) {
    const conflict = await env.DB.prepare("SELECT 1 FROM members WHERE (id='owner' AND email<>?) OR (email=? AND role<>'owner')").bind(owner,owner).first();
    if (conflict) return;
    version = credential.version; id = 'owner'; role = 'owner';
  } else {
    const row = await env.DB.prepare("SELECT id,credential_version FROM members WHERE email=? AND role='member'").bind(address).first<{ id: string; credential_version: string }>();
    if (!row) return;
    id = row.id; role = 'member'; version = row.credential_version;
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const hash = await digest(token), now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM member_password_resets WHERE expires_at<=?').bind(now),
    env.DB.prepare(`INSERT INTO member_password_resets(token_hash,member_id,email,role,credential_version,owner_email,expires_at) SELECT ?,?,?,?,?,?,? WHERE
      (?='member' AND EXISTS(SELECT 1 FROM members WHERE id=? AND email=? AND role='member' AND credential_version=?))
      OR (?='owner' AND EXISTS(SELECT 1 FROM admin_credentials WHERE id=1 AND version=?) AND NOT EXISTS(SELECT 1 FROM members WHERE (id='owner' AND email<>?) OR (email=? AND role<>'owner')))`)
      .bind(hash, id, address, role, version, owner, now + 30 * 60000, role, id, address, version, role, version, owner, owner)
  ]);
  if (!results[1].meta.changes) return;
  try { await deliver(env, { email: address, token }); }
  catch {
    // Keep the same response for absent accounts and delivery failures; a new request can retry.
    await env.DB.prepare('DELETE FROM member_password_resets WHERE token_hash=?').bind(hash).run();
  }
}

export async function confirmPasswordReset(env: Env, token: unknown, newPassword: string) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw invalid();
  const response = await service(env).fetch('https://password.internal/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenHash: await digest(token), newPassword, ownerEmail: env.SUPERADMIN_EMAIL!.trim().toLowerCase() })
  });
  if (response.status === 400) throw invalid();
  if (!response.ok) throw new PasswordResetError(503, '비밀번호 설정을 확인한 뒤 다시 시도해 주세요.', 'admin_unconfigured');
  return await response.json() as { workspaceSlug: string; namespace: string | null };
}
