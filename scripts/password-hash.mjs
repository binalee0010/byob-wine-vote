import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from './password.mjs';

const target = process.argv[2];
if (!process.stdin.isTTY || !['--local', '--remote'].includes(target))
  throw new Error('터미널에서 npm run password:hash -- --local 또는 --remote 를 실행하세요.');
if (target === '--remote') {
  const cfg = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  if (!cfg.d1_databases?.[0]?.database_id || cfg.d1_databases[0].database_id === '00000000-0000-0000-0000-000000000000')
    throw new Error('wrangler.jsonc에 직접 생성한 운영 D1 ID를 설정하세요.');
  console.error('관리자 비밀번호를 설정할 Worker:', cfg.name);
}
const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
const ask = prompt => {
  process.stderr.write(prompt);
  return new Promise(resolve => rl.question('', value => { process.stderr.write('\n'); resolve(value); }));
};
let hash;
try {
  const password = await ask('새 관리자 비밀번호 (10자 이상, 입력 숨김): ');
  if (password !== await ask('비밀번호 확인: ')) throw new Error('비밀번호가 일치하지 않습니다.');
  hash = await hashPassword(password);
} finally {
  rl.close();
}
if (target === '--local') {
  await writeFile(new URL('../.dev.vars', import.meta.url), `ADMIN_PASSWORD_HASH=${JSON.stringify(hash)}\n`, { mode: 0o600, flag: 'wx' });
  console.error('로컬 비밀번호를 설정했습니다.');
} else {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'ADMIN_PASSWORD_HASH'], {
    input: hash + '\n', stdio: ['pipe', 'inherit', 'inherit']
  });
}
