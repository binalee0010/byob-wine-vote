import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export {default as App,RankedVote,viewChangeReason} from './App'; export {Progress} from './Admin'; export {progressServerFields,progressSettingsUpdate} from './forms';`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'visibility-hooks', setup(builder) {
  builder.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'test' }));
  builder.onLoad({ filter: /^hooks$/, namespace: 'test' }, () => ({ contents: `export const useState=v=>globalThis.visibilityHooks.state(v);export const useRef=v=>globalThis.visibilityHooks.memo(()=>({current:v}),[]);export const useEffect=(fn,deps)=>globalThis.visibilityHooks.effect(fn,deps);export const useLayoutEffect=useEffect;export const useCallback=(fn,deps)=>globalThis.visibilityHooks.memo(()=>fn,deps);export const useMemo=(fn,deps)=>globalThis.visibilityHooks.memo(fn,deps);export const useId=()=>globalThis.visibilityHooks.memo(()=> 'visibility',[]);` }));
  builder.onResolve({ filter: /^react\/jsx-runtime$/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
} }] });
const { App, RankedVote, Progress, viewChangeReason, progressServerFields, progressSettingsUpdate } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const named = (tree, name) => nodes(tree).find(node => node.type?.name === name);
const settle = () => new Promise(resolve => setImmediate(resolve));
function mount(render) {
  let cursor = 0; const slots = [], pending = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));
  const hooks = {
    state(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    memo(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; },
    effect(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) { const previous = slots[index]; slots[index] = { deps }; pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = fn(); }); } },
  };
  return { render() { cursor = 0; globalThis.visibilityHooks = hooks; const tree = render(); pending.splice(0).forEach(run => run()); return tree; }, close() { slots.forEach(slot => slot.cleanup?.()); } };
}
function environment() {
  const previous = Object.fromEntries(['window', 'document', 'fetch', 'location', 'visibilityHooks'].map(key => [key, globalThis[key]]));
  const polls = []; globalThis.window = { setTimeout(fn, delay) { if (delay === 3000) polls.push(fn); return polls.length; }, clearTimeout() {}, requestAnimationFrame(fn) { fn(); } };
  globalThis.document = { getElementById: () => null }; globalThis.location = { origin: 'https://vote.test', pathname: '/v/poll' };
  return { polls, restore() { Object.assign(globalThis, previous); } };
}
const activity = (resultVisibility, status = 'closed') => ({ id: 'byob', title: '질문', revision: 2, status, started: true, published: resultVisibility !== 'private' && status === 'closed', resultVisibility, resultsLocked: true });
const participant = { id: 'joined', name: '먼저 참여한 이름' };

test('three result scopes save before or after closing and show the requested labels', async () => {
  const env = environment(); const state = { event: { title: '모임', memo: '' }, activities: [activity('private')], participants: [], submittedCount: 0, candidates: [] };
  const app = mount(() => Progress({ state, action: async () => true, busy: false })); let control;
  try {
    control = mount(() => named(app.render(), 'ActivityControl').type(named(app.render(), 'ActivityControl').props));
    const select = nodes(control.render()).find(node => node.type === 'select');
    assert.deepEqual(nodes(select).filter(node => node.type === 'option').map(node => [node.props.value, node.props.children]), [['private', '호스트만 보기'], ['participants', '참가자만 보기'], ['public', '전체 공개']]);
    for (const status of ['waiting', 'open', 'closed']) for (const scope of ['private', 'participants', 'public']) {
      const next = { ...state, activities: [activity('private', status)] }; const server = progressServerFields(next);
      const update = progressSettingsUpdate(next, server, { 'byob:2:resultVisibility': scope });
      assert.equal(update.patch.activities?.[0]?.resultVisibility ?? 'private', scope);
    }
  } finally { await settle(); control?.close(); app.close(); env.restore(); }
});

test('participant-only guests receive the existing-name login form and cannot load results', async () => {
  const env = environment(); globalThis.fetch = async () => Response.json({ event: { title: '모임' }, activities: [activity('participants')], participant: null, admin: false });
  const entry = mount(App); const screen = entry.render(); const app = mount(() => screen.type({})); let ranked;
  try {
    app.render(); await settle(); const tree = app.render();
    assert.ok(JSON.stringify(tree).includes('이 투표에 참여했던 이름')); assert.ok(JSON.stringify(tree).includes('결과 보기'));
    const props = named(tree, 'RankedVote').props; ranked = mount(() => RankedVote(props));
    assert.equal(named(ranked.render(), 'PublicResults'), undefined);
  } finally { ranked?.close(); app.close(); entry.close(); env.restore(); }
});

test('result refresh denial clears displayed rows and photo, and stale responses cannot restore them', async () => {
  const env = environment(); const changes = []; const props = { activity: activity('participants'), participant, refresh: async () => {}, onRevisionChanged: (...args) => changes.push(args) };
  const entry = mount(() => RankedVote(props)); let results;
  const row = { id: 'wine', candidateId: 'wine', name: '사진 있는 와인', number: 1, rank: 1, votes: 2, photoUrl: '/photo' };
  globalThis.fetch = async () => Response.json({ id: 'byob', title: '결과', revision: 2, participantId: 'joined', rows: [row] });
  try {
    const node = named(entry.render(), 'PublicResults'); results = mount(() => node.type(node.props)); results.render(); await settle(); let tree = results.render();
    named(tree, 'RankedResultList').props.onPhoto(row); tree = results.render(); assert.equal(named(tree, 'PhotoDialog').props.photo, row);
    globalThis.fetch = async () => Response.json({ error: '참여했던 이름으로 로그인해 주세요.', code: 'participant_required' }, { status: 403 });
    await env.polls.shift()(); tree = results.render(); assert.equal(named(tree, 'RankedResultList'), undefined); assert.equal(named(tree, 'PhotoDialog').props.photo, null); assert.equal(changes.length, 1);
    globalThis.fetch = async () => Response.json({ id: 'byob', revision: 2, participantId: 'another-session', rows: [row] });
    await env.polls.shift()(); tree = results.render(); assert.equal(named(tree, 'RankedResultList'), undefined); assert.equal(named(tree, 'PhotoDialog').props.photo, null);
    let release; globalThis.fetch = () => new Promise(resolve => { release = resolve; }); const pending = env.polls.shift()(); results.close(); release(Response.json({ id: 'byob', revision: 2, participantId: 'joined', rows: [row] })); await pending;
    assert.equal(named(results.render(), 'RankedResultList'), undefined);
    assert.equal(viewChangeReason(activity('participants'), { id: 'byob', revision: 2, results: true, resultVisibility: 'public' }), 'private');
  } finally { results?.close(); entry.close(); env.restore(); }
});
