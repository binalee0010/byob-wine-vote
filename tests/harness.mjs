import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { hashPassword } from '../scripts/password.mjs';

export const TEST_PASSWORD = 'Synthetic-test-password-2026!';
const defaultPasswordHash = await hashPassword(TEST_PASSWORD);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export async function createApp({ publicOrigin, persist = false, persistenceRoot, passwordHash = defaultPasswordHash, legacy = false, bindings = {} } = {}) {
  const result = await build({ absWorkingDir: projectRoot, entryPoints: ['worker/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:crypto', 'node:buffer'] });
  const mf = new Miniflare({ ...convertV4MiniflareOptions({ name: 'byob-test',
    modules: [{ type: 'ESModule', path: 'worker.mjs', contents: result.outputFiles[0].text }],
    compatibilityDate: '2026-11-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'byob-test-db' }, r2Buckets: { PHOTOS: 'byob-test-photos' },
    durableObjects: { PASSWORD_VERIFIER: { className: 'PasswordVerifier', useSQLite: true } },
    bindings: { ADMIN_PASSWORD_HASH: passwordHash, ...(publicOrigin ? { PUBLIC_ORIGIN: publicOrigin } : {}), ...bindings }
  }), ...(persist ? { resourcePersistencePath: persistenceRoot } : {}) });
  try {
    const db = await mf.getD1Database('DB');
    if (!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event'").first()) {
      const folder = new URL(legacy ? './fixtures/legacy/' : '../migrations/', import.meta.url);
      for (const file of (await readdir(folder)).filter(name => name.endsWith('.sql')).sort()) {
        const schema = await readFile(new URL(file, folder), 'utf8');
        for (const statement of schema.replace(/^\uFEFF/, '').split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean)) {
          await db.prepare(statement).run();
        }
      }
    }
    return { mf, db };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

export function client(mf, initialCookie = '') {
  let cookie = initialCookie;
  return async function request(path, method = 'GET', data, options = {}) {
    const headers = { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { Origin: 'https://vote.test' } : {}), ...options.headers };
    let body;
    if (data instanceof FormData) {
      const encoded = new Request('https://vote.test', { method: 'POST', body: data });
      headers['Content-Type'] = encoded.headers.get('content-type');
      body = await encoded.arrayBuffer();
    } else if (data !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(data);
    }
    const response = await mf.dispatchFetch(`https://vote.test${path}`, { method, headers, body });
    const set = response.headers.get('set-cookie');
    if (set) {
      const name = set.split('=')[0];
      const pairs = cookie ? cookie.split('; ') : [];
      cookie = [...pairs.filter(p => !p.startsWith(name + '=')), set.split(';')[0]].join('; ');
    }
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  };
}

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS0AAAAASUVORK5CYII=', 'base64');
export function photo(name = 'Synthetic wine', requestId = crypto.randomUUID()) {
  const form = new FormData();
  form.set('file', new File([PNG], 'wine.png', { type: 'image/png' }));
  form.set('name', name);
  form.set('requestId', requestId);
  return form;
}
