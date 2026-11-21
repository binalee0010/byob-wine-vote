import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createApp } from './harness.mjs';
import { mailConfiguration } from '../worker/signup-mail.ts';

const smtp = JSON.stringify({ secure: true, host: 'smtp.example.test', port: 465, user: 'synthetic', pass: 'synthetic', from: 'BYOB <noreply@example.test>' });
const result = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'], loader: { '.sql': 'text' },
  plugins: [{ name: 'synthetic-mail-transport', setup(builder) {
    builder.onResolve({ filter: /^nodemailer$/ }, () => ({ path: 'nodemailer', namespace: 'synthetic-mail' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic-mail' }, () => ({ contents: `
      export function createTransport(options) {
        globalThis.__resetMailOptions = options;
        return { async sendMail(message) {
          globalThis.__resetMailMessages.push(message);
          if(globalThis.__resetMailFailure) throw new Error('synthetic provider failure');
          return { accepted: [message.to], rejected: [] };
        }, close() { globalThis.__resetMailClosed++; } };
      }` }));
  } }] });
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('public requests send canonical fragment links via the existing secure SMTP transport and conceal failed delivery', async () => {
  const local = await createApp({ bindings: { SUPERADMIN_EMAIL: 'owner@example.test' } });
  globalThis.__resetMailMessages = []; globalThis.__resetMailClosed = 0;
  try {
    const env = { DB: local.db, SUPERADMIN_EMAIL: 'owner@example.test', PUBLIC_ORIGIN: 'https://canonical.example.test', SMTP_CONFIG: smtp,
      PASSWORD_VERIFIER: await local.mf.getDurableObjectNamespace('PASSWORD_VERIFIER') };
    const request = email => worker.fetch(new Request('https://alias.example.test/api/members/password-reset/request', {
      method: 'POST', headers: { Origin: 'https://alias.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
    }), env);
    const known = await request(' OWNER@EXAMPLE.TEST '), absent = await request('absent@example.test');
    assert.equal(known.status, 200); assert.equal(absent.status, 200);
    assert.deepEqual(await known.json(), await absent.json());
    assert.equal(globalThis.__resetMailMessages.length, 1);
    const message = globalThis.__resetMailMessages[0];
    assert.equal(message.to, 'owner@example.test'); assert.equal(message.subject, '와인 인기투표 비밀번호 재설정');
    const link = new URL(message.text.match(/https:\/\/[^\s]+/)[0]), token = link.hash.slice('#reset='.length);
    assert.equal(link.origin, env.PUBLIC_ORIGIN); assert.equal(link.pathname, '/'); assert.equal(link.search, '');
    assert.match(token, /^[a-f0-9]{64}$/); assert(message.text.includes('30분'));
    const row = await local.db.prepare('SELECT * FROM member_password_resets').first();
    assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex')); assert(!JSON.stringify(row).includes(token));
    const options = globalThis.__resetMailOptions;
    assert.equal(options.secure, true); assert.equal(options.host, 'smtp.example.test');
    assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true); assert.equal(typeof options.getSocket, 'function');
    globalThis.__resetMailFailure = true;
    assert.deepEqual(await (await request('owner@example.test')).json(), { ok: true });
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM member_password_resets').first()).n, 1);
    globalThis.__resetMailFailure = false;
    assert.equal((await request('owner@example.test')).status, 200);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM member_password_resets').first()).n, 2);
    assert.equal(globalThis.__resetMailClosed, 3);
  } finally {
    delete globalThis.__resetMailMessages; delete globalThis.__resetMailOptions; delete globalThis.__resetMailFailure; delete globalThis.__resetMailClosed;
    await local.mf.dispose();
  }
});

test('mail configuration rejects noncanonical URLs, insecure SMTP and header injection before any account lookup', () => {
  const valid = { PUBLIC_ORIGIN: 'https://canonical.example.test/', SMTP_CONFIG: smtp };
  assert.equal(mailConfiguration(valid).origin.origin, 'https://canonical.example.test');
  for (const PUBLIC_ORIGIN of ['http://canonical.example.test', 'https://user:pass@canonical.example.test', 'https://canonical.example.test/path', 'https://canonical.example.test/?next=evil', 'https://canonical.example.test/#evil', 'javascript:alert(1)']) {
    assert.throws(() => mailConfiguration({ ...valid, PUBLIC_ORIGIN }));
  }
  for (const patch of [{ secure: false }, { port: 0 }, { port: 65536 }, { host: 'bad host' }, { from: 'safe@example.test\r\nBcc: bad@example.test' }]) {
    assert.throws(() => mailConfiguration({ ...valid, SMTP_CONFIG: JSON.stringify({ ...JSON.parse(smtp), ...patch }) }));
  }
});
