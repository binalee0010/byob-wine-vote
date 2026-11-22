import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export {CandidatePhotoEditor,sendPhoto,Candidates} from './Admin';export {setMemberCsrfToken,setMemberWorkspaceSlug} from './api';`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'photo-editor-hooks', setup(builder) {
  builder.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'test' }));
  builder.onLoad({ filter: /^hooks$/, namespace: 'test' }, () => ({ contents: `export const useState=v=>globalThis.photoHooks.state(v);export const useRef=v=>globalThis.photoHooks.memo(()=>({current:v}),[]);export const useEffect=(fn,deps)=>globalThis.photoHooks.effect(fn,deps);export const useLayoutEffect=useEffect;export const useCallback=(fn,deps)=>globalThis.photoHooks.memo(()=>fn,deps);export const useMemo=(fn,deps)=>globalThis.photoHooks.memo(fn,deps);export const useId=()=>globalThis.photoHooks.memo(()=> 'photo',[]);` }));
  builder.onResolve({ filter: /^\.\/image$/ }, () => ({ path: 'image', namespace: 'test' }));
  builder.onLoad({ filter: /^image$/, namespace: 'test' }, () => ({ contents: `export const preparePhoto=file=>globalThis.prepareTestPhoto(file);` }));
  builder.onResolve({ filter: /^react\/jsx-runtime$/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
} }] });
const { CandidatePhotoEditor, sendPhoto, Candidates, setMemberCsrfToken, setMemberWorkspaceSlug } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
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
  return { render() { cursor = 0; globalThis.photoHooks = hooks; const tree = render(); pending.splice(0).forEach(run => run()); return tree; }, close() { slots.forEach(slot => slot.cleanup?.()); } };
}
function environment() {
  const previous = Object.fromEntries(['window', 'document', 'fetch', 'XMLHttpRequest', 'location', 'photoHooks', 'prepareTestPhoto'].map(key => [key, globalThis[key]]));
  const requests = []; globalThis.window = { setTimeout, clearTimeout }; globalThis.document = { activeElement: null }; globalThis.location = { pathname: '/admin/p/poll' };
  globalThis.XMLHttpRequest = class {
    upload = {}; headers = {};
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(body) { this.body = body; requests.push(this); }
    respond(status, body) { this.status = status; this.response = body; this.onload(); }
  };
  setMemberCsrfToken('csrf'); setMemberWorkspaceSlug('poll');
  return { requests, restore() { Object.assign(globalThis, previous); setMemberCsrfToken(null); } };
}
const candidate = { id: 'wine', number: 7, name: '원래 이름', description: '미저장 이름과 독립', photoUrl: '/old-photo' };

test('selecting multiple photos uploads immediately, continues after failure and retries only the original failed request', async () => {
  const env = environment(); const prepared = []; const busy = []; let refreshed = 0;
  const state = { activities: [{ id: 'byob', revision: 4, status: 'waiting', started: false }], candidates: [candidate], photoCleanupPending: 0 };
  globalThis.prepareTestPhoto = async file => { prepared.push(file.name); return new File([file], file.name + '.jpg', { type: 'image/jpeg' }); };
  globalThis.fetch = async () => assert.fail('photo selection must not submit the name-only form');
  const app = mount(() => Candidates({ state, action: async () => assert.fail('photo selection must use multipart'), busy: false, refresh: async () => { refreshed++; }, onUploadBusy: value => busy.push(value) }));
  const rows = tree => nodes(tree).filter(node => node.props?.className?.startsWith('upload-row '));
  const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.props.children === label);
  const files = ['first.png', 'failed.png', 'last.png'].map(name => new File([name], name, { type: 'image/png' }));
  try {
    let tree = app.render(); const input = nodes(tree).find(node => node.type === 'input' && node.props.multiple);
    input.props.onChange({ target: { files: [], value: '' } }); await settle(); assert.equal(env.requests.length, 0); assert.deepEqual(busy, []);
    const selection = { files, value: 'selected' }; input.props.onChange({ target: selection }); input.props.onChange({ target: { files, value: 'duplicate' } }); await settle();
    assert.equal(selection.value, ''); assert.equal(env.requests.length, 1); tree = app.render(); assert.equal(rows(tree).length, 3);
    assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.multiple).props.disabled, true);
    assert.equal(button(tree, '선택한 사진 등록'), undefined);
    for (let i = 0; i < 3; i++) {
      const request = env.requests[i]; assert.ok(request, 'later selected files must be attempted');
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v/poll/api/admin/candidates'); assert.equal(request.headers['X-Member-CSRF'], 'csrf');
      assert.equal(request.body.get('revision'), '4'); assert.equal(request.body.get('name'), null); assert.equal(request.body.get('file').name, files[i].name + '.jpg');
      assert.equal(request.body.get('requestId'), rows(app.render())[i].key);
      request.upload.onprogress({ lengthComputable: true, loaded: 1, total: 4 });
      assert.ok(JSON.stringify(rows(app.render())[i]).includes('업로드 25%'));
      request.respond(i === 1 ? 503 : 200, i === 1 ? { error: '이 파일 실패' } : { candidate: { id: 'saved-' + i, number: i + 1, name: '와인 0' + (i + 1), photoUrl: '/photo-' + i } }); await settle();
    }
    tree = app.render(); assert.deepEqual(rows(tree).map(row => row.props.className), ['upload-row done', 'upload-row error', 'upload-row done']);
    assert.ok(JSON.stringify(rows(tree)[0]).includes('와인 01')); assert.ok(JSON.stringify(rows(tree)[2]).includes('와인 03'));
    const retry = button(tree, '다시 시도'); assert.ok(retry); assert.equal(retry.props['aria-label'], 'failed.png 다시 시도');
    assert.equal(button(tree, '실패한 와인 다시 시도'), undefined); retry.props.onClick(); retry.props.onClick(); await settle();
    assert.equal(env.requests.length, 4); assert.deepEqual(prepared, files.map(file => file.name));
    assert.equal(env.requests[3].body.get('requestId'), env.requests[1].body.get('requestId')); assert.equal(env.requests[3].body.get('file'), env.requests[1].body.get('file'));
    env.requests[3].respond(200, { candidate: { id: 'saved-retry', number: 3, name: '와인 03', photoUrl: '/retried' } }); await settle(); tree = app.render();
    assert.ok(rows(tree).every(row => row.props.className === 'upload-row done')); assert.equal(button(tree, '실패한 와인 다시 시도'), undefined);
    assert.equal(new Set(env.requests.map(request => request.body.get('requestId'))).size, 3); assert.equal(refreshed, 3); assert.deepEqual(busy, [true, false, true, false]);
  } finally { app.close(); env.restore(); }
});

test('a failed refresh after upload success leaves the row done and continues the batch without retrying it', async () => {
  const env = environment(); let refreshed = 0;
  globalThis.prepareTestPhoto = async file => file;
  const state = { activities: [{ id: 'byob', revision: 4, status: 'waiting', started: false }], candidates: [], photoCleanupPending: 0 };
  const app = mount(() => Candidates({ state, action: async () => true, busy: false, refresh: async () => { if (++refreshed === 1) throw new Error('목록 갱신 실패'); }, onUploadBusy() {} }));
  try {
    const input = nodes(app.render()).find(node => node.type === 'input' && node.props.multiple);
    input.props.onChange({ target: { files: [new File(['one'], 'one.png'), new File(['two'], 'two.png')], value: 'selected' } }); await settle();
    env.requests[0].respond(200, { candidate: { id: 'one', name: '와인 01' } }); await settle();
    assert.equal(env.requests.length, 2); let tree = app.render();
    assert.equal(nodes(tree).find(node => node.props?.className === 'upload-row done').key, env.requests[0].body.get('requestId'));
    assert.ok(JSON.stringify(tree).includes('목록 갱신 실패'));
    env.requests[1].respond(200, { candidate: { id: 'two', name: '와인 02' } }); await settle(); tree = app.render();
    assert.equal(nodes(tree).filter(node => node.props?.className === 'upload-row done').length, 2);
    assert.equal(nodes(tree).filter(node => node.type === 'button' && ['다시 시도', '실패한 와인 다시 시도'].includes(node.props.children)).length, 0);
    assert.equal(env.requests.length, 2); assert.equal(refreshed, 2);
  } finally { app.close(); env.restore(); }
});

test('name-only registration still submits each name once without preparing photos', async () => {
  const env = environment(); const requests = []; let refreshed = 0;
  globalThis.prepareTestPhoto = async () => assert.fail('name-only registration must not prepare an image');
  globalThis.fetch = async (path, init) => { requests.push([path, init]); return Response.json({ candidate: { id: 'named-' + requests.length } }); };
  const state = { activities: [{ id: 'byob', revision: 4, status: 'waiting', started: false }], candidates: [], photoCleanupPending: 0 };
  const app = mount(() => Candidates({ state, action: async () => true, busy: false, refresh: async () => { refreshed++; }, onUploadBusy() {} }));
  try {
    let tree = app.render(); nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: '첫 와인\n둘째 와인' } }); tree = app.render();
    const submit = nodes(tree).find(node => node.type === 'form' && node.props.className === 'wine-name-form').props.onSubmit;
    submit({ preventDefault() {} }); submit({ preventDefault() {} }); await settle(); tree = app.render();
    assert.equal(env.requests.length, 0); assert.equal(refreshed, 2); assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, '');
    assert.deepEqual(requests.map(([path, init]) => [path, init.method, JSON.parse(init.body).name, JSON.parse(init.body).revision]), [['/v/poll/api/admin/candidates', 'POST', '첫 와인', 4], ['/v/poll/api/admin/candidates', 'POST', '둘째 와인', 4]]);
    assert.equal(new Set(requests.map(([, init]) => JSON.parse(init.body).requestId)).size, 2); assert.ok(requests.every(([, init]) => init.headers['X-Member-CSRF'] === 'csrf'));
  } finally { app.close(); env.restore(); }
});

test('photo replacement preserves the existing image on failure and retries the prepared file with one request id', async () => {
  const env = environment(); let busy = false, prepared = 0, refreshed = 0;
  globalThis.prepareTestPhoto = async file => { prepared++; return new File([file], 'prepared.jpg', { type: 'image/jpeg' }); };
  const app = mount(() => CandidatePhotoEditor({ candidate, revision: 4, busy, onStart() { if (busy) return false; busy = true; return true; }, onFinish() { busy = false; }, refresh: async () => { refreshed++; }, onPhoto() {} }));
  const file = new File(['photo'], 'selected.png', { type: 'image/png' });
  try {
    let tree = app.render(); const input = nodes(tree).find(node => node.type === 'input');
    input.props.onChange({ target: { files: [file], value: 'selected' } }); input.props.onChange({ target: { files: [file], value: 'selected' } }); await settle();
    assert.equal(env.requests.length, 1); tree = app.render(); assert.equal(nodes(tree).find(node => node.type === 'input').props.disabled, true);
    const first = env.requests[0]; assert.equal(first.method, 'PUT'); assert.equal(first.url, '/v/poll/api/admin/candidates/wine/photo'); assert.equal(first.headers['X-Member-CSRF'], 'csrf');
    assert.equal(first.body.get('expectedPhotoUrl'), '/old-photo'); assert.equal(first.body.get('revision'), '4'); assert.equal(first.body.get('file').name, 'prepared.jpg'); assert.equal(first.body.get('name'), null);
    first.upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 }); assert.ok(JSON.stringify(app.render()).includes('업로드 50%'));
    first.respond(503, { error: '다시 시도해 주세요.' }); await settle(); tree = app.render(); assert.equal(named(tree, 'CandidatePhoto').props.candidate.photoUrl, '/old-photo');
    nodes(tree).find(node => node.type === 'button' && node.props.children === '사진 다시 시도').props.onClick(); await settle();
    assert.equal(prepared, 1); assert.equal(env.requests[1].body.get('requestId'), first.body.get('requestId'));
    env.requests[1].respond(200, { ok: true, candidate: { ...candidate, photoUrl: '/photo?v=new', name: '서버 다른 이름' } }); await settle(); tree = app.render();
    assert.equal(refreshed, 1); assert.deepEqual(named(tree, 'CandidatePhoto').props.candidate, { ...candidate, photoUrl: '/photo?v=new' }); assert.ok(JSON.stringify(tree).includes('사진을 저장했습니다.'));
  } finally { app.close(); env.restore(); }
});

test('photo controls exist for every candidate while waiting, open, or closed without replacing name editors', () => {
  const env = environment();
  try {
    for (const status of ['waiting', 'open', 'closed']) {
      const state = { activities: [{ id: 'byob', revision: 4, status, started: status !== 'waiting' }], candidates: [candidate, { ...candidate, id: 'no-photo', photoUrl: null }], photoCleanupPending: 0 };
      const app = mount(() => Candidates({ state, action: async () => true, busy: false, refresh: async () => {}, onUploadBusy() {} }));
      try {
        const tree = app.render(); const editors = nodes(tree).filter(node => node.type?.name === 'CandidatePhotoEditor'); assert.equal(editors.length, 2);
        assert.equal(named(tree, 'ServerTextInput').props.disabled, status === 'open');
        for (const editor of editors) {
          const child = mount(() => editor.type(editor.props)); try { const input = nodes(child.render()).find(node => node.type === 'input'); assert.equal(input.props.disabled, false); assert.equal(input.props.multiple, undefined); assert.match(input.props['aria-label'], editor.props.candidate.photoUrl ? /사진 변경$/ : /사진 추가$/); } finally { child.close(); }
        }
      } finally { app.close(); }
    }
  } finally { env.restore(); }
});

test('replacement rejects mismatched success acknowledgements without applying a photo', async () => {
  const env = environment();
  try {
    const file = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
    const result = sendPhoto({ id: 'request-id', revision: 4, name: 'unused' }, file, () => {}, { candidateId: 'wine', expectedPhotoUrl: '' });
    env.requests[0].respond(200, { ok: true, candidate: { ...candidate, id: 'other', photoUrl: '/wrong' } }); await assert.rejects(result);
  } finally { env.restore(); }
});
