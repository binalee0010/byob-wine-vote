import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const startup = await readFile(new URL('../public/startup.js', import.meta.url), 'utf8');
for (const path of ['/', '/admin', '/admin/', '/admin/p/saved-poll', '/admin/p/saved-poll/', '/v/saved-poll']) {
  test(`startup uses the current screen role before loading saved titles (${path})`, () => {
    const heading = {}, retry = { addEventListener() {} };
    const document = { getElementById: id => id === 'startup-retry' ? retry : heading };
    runInNewContext(startup, {
      URL, document, location: { href: 'https://vote.example.test' + path },
      window: { addEventListener() {}, removeEventListener() {} }, setTimeout() { return 1; }, clearTimeout() {},
    });
    const expected = path.startsWith('/admin') ? '투표 관리' : '와인 인기투표';
    assert.equal(document.title, expected); assert.equal(heading.textContent, expected);
  });
}
