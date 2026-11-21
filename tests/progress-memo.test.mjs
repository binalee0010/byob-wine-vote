import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/forms.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { keepProgressEdits, progressServerFields, progressDraftChanges, progressSettingsUpdate } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const state = memo => ({ event: { title: '개별 투표', memo }, activities: [] });

test('poll memo defaults to empty and saves multiline text or an explicit clear without changing other settings', () => {
  assert.equal(progressServerFields(state())['event:memo'], '');
  const memo = '첫째 줄\n  둘째 줄  ';
  const server = progressServerFields(state(''));
  const edits = { 'event:memo': memo };
  assert.deepEqual(progressDraftChanges(state(''), server, edits), edits);
  assert.deepEqual(progressSettingsUpdate(state(''), server, edits), { patch: { event: { memo } }, changes: edits });
  assert.deepEqual(progressSettingsUpdate(state(memo), progressServerFields(state(memo)), { 'event:memo': '' }), { patch: { event: { memo: '' } }, changes: { 'event:memo': '' } });
  assert.deepEqual(progressSettingsUpdate(state(memo), progressServerFields(state(memo)), { 'event:title': '새 제목' }).patch, { event: { title: '새 제목' } });
});

test('poll memo draft survives polling and failure until the matching saved value arrives', () => {
  const edits = { 'event:memo': '저장 전\n메모' };
  const polling = progressServerFields(state('다른 화면의 메모'));
  assert.deepEqual(keepProgressEdits(edits, polling), edits);
  const update = progressSettingsUpdate(state('다른 화면의 메모'), polling, edits);
  assert.deepEqual(update.changes, edits);
  assert.deepEqual(keepProgressEdits(update.changes, polling), edits);
  assert.deepEqual(keepProgressEdits(update.changes, progressServerFields(state(edits['event:memo']))), {});
});
