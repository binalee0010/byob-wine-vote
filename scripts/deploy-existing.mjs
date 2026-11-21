import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function existingConfig(input, base) {
  const valid = (condition, field) => { if (!condition) throw new Error(`Invalid existing deployment field: ${field}`); };
  valid(input && typeof input === 'object' && !Array.isArray(input), 'config');
  for (const field of ['workerName', 'databaseName', 'bucketName']) valid(typeof input[field] === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(input[field]), field);
  valid(typeof input.accountId === 'string' && /^[a-f0-9]{32}$/.test(input.accountId), 'accountId');
  valid(typeof input.databaseId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.databaseId) && input.databaseId !== '00000000-0000-0000-0000-000000000000', 'databaseId');
  let origin;
  try { origin = new URL(input.publicOrigin); } catch { valid(false, 'publicOrigin'); }
  valid(origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash && !origin.port, 'publicOrigin');
  valid(Array.isArray(input.routes) && input.routes.length > 0 && input.routes.length <= 10
    && input.routes.every(host => typeof host === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))
    && input.routes.includes(origin.hostname), 'routes');
  for (const field of ['adminSessionCookie', 'participantSessionCookie']) valid(typeof input[field] === 'string' && /^__Host-[A-Za-z0-9_-]{1,64}$/.test(input[field]), field);
  valid(input.adminSessionCookie !== input.participantSessionCookie, 'session cookies');
  return {
    ...base, name: input.workerName, account_id: input.accountId, workers_dev: false, preview_urls: false,
    vars: { PUBLIC_ORIGIN: origin.origin, ADMIN_SESSION_COOKIE: input.adminSessionCookie, PARTICIPANT_SESSION_COOKIE: input.participantSessionCookie },
    d1_databases: [{ binding: 'DB', database_name: input.databaseName, database_id: input.databaseId, migrations_dir: 'migrations-existing' }],
    r2_buckets: [{ binding: 'PHOTOS', bucket_name: input.bucketName }],
    routes: [...new Set(input.routes)].map(pattern => ({ pattern, custom_domain: true }))
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const target = resolve(root, `wrangler.existing.${crypto.randomUUID()}.local.jsonc`);
  try {
    const raw = process.env.VOTE_DEPLOY_CONFIG ?? await readFile(resolve(root, '.deploy-existing.json'), 'utf8');
    let input;
    try { input = JSON.parse(raw); } catch { throw new Error('VOTE_DEPLOY_CONFIG / .deploy-existing.json must contain valid JSON.'); }
    const base = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
    const config = existingConfig(input, base);
    await writeFile(target, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--dry-run')) throw new Error('Only --dry-run is supported.');
    const child = spawnSync(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', target, ...args], { cwd: root, stdio: 'inherit' });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
