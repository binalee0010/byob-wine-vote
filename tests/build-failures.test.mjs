import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'], loader: { '.sql': 'text' },
  plugins: [{ name: 'synthetic-build-mail', setup(builder) {
    builder.onResolve({ filter: /^nodemailer$/ }, () => ({ path: 'nodemailer', namespace: 'synthetic-build-mail' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic-build-mail' }, () => ({ contents: `
      export function createTransport(options) {
        globalThis.__buildMailOptions = options;
        return { async sendMail(message) {
          globalThis.__buildMailMessages.push(message);
          if (globalThis.__buildMailFailure === globalThis.__buildMailMessages.length) throw new Error('synthetic provider failure');
          if (globalThis.__buildMailFailure === 'rejected') return { accepted: [], rejected: [message.to] };
          return { accepted: [message.to], rejected: [] };
        }, close() { globalThis.__buildMailClosed++; } };
      }` }));
  } }] });
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const env = { SUPERADMIN_EMAIL: 'owner@example.test', PUBLIC_ORIGIN: 'https://vote.example.test',
  SMTP_CONFIG: JSON.stringify({ secure: true, host: 'smtp.example.test', port: 465, user: 'synthetic', pass: 'synthetic', from: 'BYOB <noreply@example.test>' }) };

// Official Workers Builds event envelope; free-form fields must never enter the mail.
function event() {
  return {
    type: 'cf.workersBuilds.worker.build.failed', source: { type: 'workersBuilds.worker', workerName: 'vinolog-vote' },
    payload: { buildUuid: 'build-12345678-90ab-cdef-1234-567890abcdef', status: 'failed', buildOutcome: 'failure',
      buildTriggerMetadata: { buildTriggerSource: 'push_event', branch: 'main', commitHash: 'a'.repeat(40),
        repoName: 'byob-wine-vote', providerAccountName: 'binalee0010', providerType: 'github',
        commitMessage: 'private build content', author: 'intruder@example.test', deployCommand: 'secret command' },
      logs: 'private build logs', to: 'intruder@example.test' },
    metadata: { accountId: 'b'.repeat(32), eventSubscriptionId: 'c'.repeat(32), eventSchemaVersion: 1, eventTimestamp: '2026-11-22T00:00:00.000Z' }
  };
}
function message(body = event()) {
  return { body, acknowledgements: 0, retries: 0, ack() { this.acknowledgements++; }, retry() { this.retries++; } };
}
const batch = messages => ({ queue: 'vinolog-vote-deploy-failures', messages });
test.beforeEach(() => { globalThis.__buildMailMessages = []; globalThis.__buildMailClosed = 0; });
test.afterEach(() => {
  for (const key of ['__buildMailMessages', '__buildMailOptions', '__buildMailFailure', '__buildMailClosed']) delete globalThis[key];
});

test('production failures use the fixed operator recipient, safe build link and existing TLS transport', async () => {
  const first = message(), duplicate = message();
  await worker.queue(batch([first]), env);
  await worker.queue(batch([duplicate]), env);
  assert.equal(first.acknowledgements, 1); assert.equal(first.retries, 0);
  const [mail, redelivery] = globalThis.__buildMailMessages;
  assert.equal(mail.to, env.SUPERADMIN_EMAIL); assert.equal(mail.subject, '[BYOB] 운영 배포 실패');
  assert.equal(mail.messageId, '<byob-deploy-failure-build-12345678-90ab-cdef-1234-567890abcdef@vote.example.test>');
  assert.equal(redelivery.messageId, mail.messageId);
  assert.match(mail.text, /운영 빌드 또는 배포가 실패/);
  assert.equal(mail.text.match(/https:\/\/\S+/g)[0], `https://dash.cloudflare.com/${'b'.repeat(32)}/workers/services/view/vinolog-vote/production/builds/build-12345678-90ab-cdef-1234-567890abcdef`);
  for (const value of ['private build content', 'private build logs', 'intruder@example.test', 'secret command']) assert(!JSON.stringify(mail).includes(value));
  const options = globalThis.__buildMailOptions;
  assert.equal(options.secure, true); assert.equal(options.host, 'smtp.example.test');
  assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true); assert.equal(typeof options.getSocket, 'function');
  assert.equal(globalThis.__buildMailClosed, 2);
});

test('success, cancelled, preview, GitHub checks and other sources are acknowledged without mail', async () => {
  const patches = [
    value => { value.type = 'cf.workersBuilds.worker.build.succeeded'; },
    value => { value.type = 'cf.workersBuilds.worker.build.canceled'; },
    value => { value.type = 'check_run'; },
    value => { value.source.type = 'github'; },
    value => { value.source.workerName = 'another-worker'; },
    value => { value.payload.status = 'success'; value.payload.buildOutcome = 'success'; },
    value => { value.payload.buildOutcome = 'canceled'; },
    value => { value.payload.buildOutcome = 'cancelled'; },
    value => { value.payload.buildTriggerMetadata.branch = 'preview'; },
    value => { value.payload.buildTriggerMetadata.branch = 'Main'; },
    value => { value.payload.buildTriggerMetadata.repoName = 'other-repo'; },
    value => { value.payload.buildTriggerMetadata.providerAccountName = 'other-owner'; },
    value => { value.payload.buildTriggerMetadata.providerType = 'gitlab'; },
    value => { delete value.payload.buildTriggerMetadata; },
    value => { value.payload.buildUuid = '../../malicious'; },
    value => { value.payload.buildUuid += '\r\nBcc: intruder@example.test'; },
    value => { value.metadata.accountId = 'malicious/path'; }
  ];
  const messages = patches.map(patch => { const value = event(); patch(value); return message(value); });
  messages.push(...[null, {}, [], 'invalid'].map(value => message(value)));
  await worker.queue(batch(messages), env);
  const wrongQueue = message();
  await worker.queue({ queue: 'another-queue', messages: [wrongQueue] }, env);
  for (const ignored of [...messages, wrongQueue]) { assert.equal(ignored.acknowledgements, 1); assert.equal(ignored.retries, 0); }
  assert.equal(globalThis.__buildMailMessages.length, 0);
});

test('authoritative failure events accept stopped status, fail outcome and absent or null outcome', async () => {
  const stopped = message(), failed = message(), absent = message(), unknown = message();
  stopped.body.payload.status = 'stopped';
  failed.body.payload.status = 'stopped'; failed.body.payload.buildOutcome = 'fail';
  delete absent.body.payload.status; delete absent.body.payload.buildOutcome;
  unknown.body.payload.buildOutcome = null;
  await worker.queue(batch([stopped, failed, absent, unknown]), env);
  assert.equal(globalThis.__buildMailMessages.length, 4);
  for (const accepted of [stopped, failed, absent, unknown]) { assert.equal(accepted.acknowledgements, 1); assert.equal(accepted.retries, 0); }
});

test('SMTP errors retry only the failed message and keep later messages independent', async () => {
  globalThis.__buildMailFailure = 1;
  const failed = message(), next = message();
  next.body.payload.buildUuid = '87654321-90AB-CDEF-1234-567890ABCDEF';
  await worker.queue(batch([failed, next]), env);
  assert.equal(failed.acknowledgements, 0); assert.equal(failed.retries, 1);
  assert.equal(next.acknowledgements, 1); assert.equal(next.retries, 0);
  assert.match(globalThis.__buildMailMessages[1].messageId, /87654321-90ab-cdef-1234-567890abcdef/);
  assert.equal(globalThis.__buildMailClosed, 2);
  const retried = message(failed.body);
  await worker.queue(batch([retried]), env);
  assert.equal(retried.acknowledgements, 1); assert.equal(retried.retries, 0);
  assert.equal(globalThis.__buildMailMessages[2].messageId, globalThis.__buildMailMessages[0].messageId);
});

test('unaccepted SMTP delivery retries and closes the transport', async () => {
  globalThis.__buildMailFailure = 'rejected';
  const pending = message();
  await worker.queue(batch([pending]), env);
  assert.equal(pending.acknowledgements, 0); assert.equal(pending.retries, 1);
  assert.equal(globalThis.__buildMailClosed, 1);
});

test('missing or injected operator addresses retry without opening a transport', async () => {
  for (const SUPERADMIN_EMAIL of [undefined, '', 'owner@example.test, intruder@example.test', 'owner@example.test; intruder@example.test', 'owner@example.test\r\nBcc: intruder@example.test']) {
    const pending = message();
    await worker.queue(batch([pending]), { ...env, SUPERADMIN_EMAIL });
    assert.equal(pending.acknowledgements, 0); assert.equal(pending.retries, 1);
  }
  assert.equal(globalThis.__buildMailMessages.length, 0);
  assert.equal(globalThis.__buildMailOptions, undefined);
});
