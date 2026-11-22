import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existingConfig } from '../scripts/deploy-existing.mjs';

const base = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const settings = {
  workerName: 'synthetic-worker', accountId: 'a'.repeat(32), databaseName: 'synthetic-db',
  databaseId: '01234567-89ab-cdef-0123-456789abcdef', bucketName: 'synthetic-photos',
  publicOrigin: 'https://vote.example.com/', routes: ['vote.example.com', 'old.example.com'],
  adminSessionCookie: '__Host-previous_admin', participantSessionCookie: '__Host-previous_participant'
};
test('existing deployment preserves bindings and isolates fresh migrations without publishing private config', () => {
  const config = existingConfig(settings, base);
  assert.equal(config.name, settings.workerName);
  assert.equal(config.vars.PUBLIC_ORIGIN, 'https://vote.example.com');
  assert.equal(config.vars.MEMBERSHIP_REQUIRED, 'true');
  assert.equal(config.vars.ADMIN_SESSION_COOKIE, settings.adminSessionCookie);
  assert.equal(config.d1_databases[0].migrations_dir, 'migrations-existing');
  assert.deepEqual(config.durable_objects, base.durable_objects);
  assert.deepEqual(config.migrations, base.migrations);
  assert.equal(config.preview_urls, false);
  assert.equal(config.workers_dev, false);
  assert.equal(config.queues, undefined);
  assert.equal(base.queues, undefined);
  assert(!JSON.stringify(config).includes('ADMIN_PASSWORD_HASH'));
  for (const patch of [
    { databaseId: '00000000-0000-0000-0000-000000000000' }, { accountId: '' },
    { publicOrigin: 'javascript:alert(1)' }, { publicOrigin: 'https://user:password@vote.example.com' },
    { publicOrigin: 'https://vote.example.com/admin' }, { routes: [] }, { routes: ['other.example.com'] },
    { routes: ['vote.example.com/path'] }, { adminSessionCookie: 'ordinary_cookie' },
    { participantSessionCookie: settings.adminSessionCookie }, { workerName: '../outside' }
  ]) assert.throws(() => existingConfig({ ...settings, ...patch }, base), /Invalid existing deployment field/);
});

test('only the existing production Worker consumes the deployment failure queue', () => {
  const production = { ...settings, workerName: 'vinolog-vote', publicOrigin: 'https://vote.vinalee.dev', routes: ['vote.vinalee.dev'] };
  const config = existingConfig(production, base);
  assert.deepEqual(config.queues, { consumers: [{ queue: 'vinolog-vote-deploy-failures', max_batch_size: 1, max_retries: 5, retry_delay: 300 }] });
  assert.equal(existingConfig({ ...settings, workerName: 'vinolog-vote' }, base).queues, undefined);
  assert.equal(existingConfig({ ...production, workerName: 'another-worker' }, base).queues, undefined);
});
