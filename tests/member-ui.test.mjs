import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export {default as MemberPortal, MemberSettings, MembershipRequests} from './MemberPortal'; export {api,apiPath,setMemberCsrfToken,setMemberWorkspaceSlug} from './api';`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'member-test-hooks', setup(builder) {
  builder.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'test' }));
  builder.onLoad({ filter: /^hooks$/, namespace: 'test' }, () => ({ contents: `export const useState=v=>globalThis.memberHooks.state(v);export const useRef=v=>globalThis.memberHooks.memo(()=>({current:v}),[]);export const useEffect=(fn,deps)=>globalThis.memberHooks.effect(fn,deps);export const useCallback=(fn,deps)=>globalThis.memberHooks.memo(()=>fn,deps);export const useId=()=>globalThis.memberHooks.memo(()=> 'member-settings',[]);` }));
  builder.onResolve({ filter: /^\.\/Admin$/ }, () => ({ path: 'admin', namespace: 'test' }));
  builder.onLoad({ filter: /^admin$/, namespace: 'test' }, () => ({ contents: `export default function Admin(){return null} export function PasswordChange(){return null}` }));
  builder.onResolve({ filter: /^react\/jsx-runtime$/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
} }] });
const { MemberPortal, MemberSettings, MembershipRequests, api, apiPath, setMemberCsrfToken, setMemberWorkspaceSlug } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const uploadBundle = await build({ stdin: { contents: `export {default as Admin,sendPhoto} from './Admin';export {default as App} from './App';export {setMemberCsrfToken,setMemberWorkspaceSlug} from './api';`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'legacy-test-hooks', setup(builder) {
  builder.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'test' }));
  builder.onLoad({ filter: /^hooks$/, namespace: 'test' }, () => ({ contents: `export const useState=v=>globalThis.memberHooks.state(v);export const useRef=v=>globalThis.memberHooks.memo(()=>({current:v}),[]);export const useEffect=(fn,deps)=>globalThis.memberHooks.effect(fn,deps);export const useLayoutEffect=useEffect;export const useCallback=(fn,deps)=>globalThis.memberHooks.memo(()=>fn,deps);export const useMemo=(fn,deps)=>globalThis.memberHooks.memo(fn,deps);export const useId=()=>globalThis.memberHooks.memo(()=> 'member-settings',[]);` }));
  builder.onResolve({ filter: /^react\/jsx-runtime$/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
} }] });
const uploadApi = await import('data:text/javascript;base64,' + Buffer.from(uploadBundle.outputFiles[0].text).toString('base64'));
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.props.children === label);
const named = (tree, name) => nodes(tree).find(node => node.type?.name === name);
const settle = () => new Promise(resolve => setImmediate(resolve));
const preventDefault = () => {};
function mount(render) {
  let cursor = 0; const slots = [], pending = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const hooks = {
    state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
    memo(fn, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    effect(fn, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) { const previous = slots[i]; slots[i] = { deps }; pending.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  return { render() { cursor = 0; globalThis.memberHooks = hooks; const tree = render(); pending.splice(0).forEach(run => run()); return tree; }, close() { slots.forEach(slot => slot.cleanup?.()); } };
}
function environment() {
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, location: globalThis.location, memberHooks: globalThis.memberHooks };
  globalThis.window = { setTimeout, clearTimeout }; globalThis.document = { activeElement: null }; globalThis.location = { pathname: '/', origin: 'https://vote.example', replacements: [], replace(path) { this.replacements.push(path); } };
  setMemberCsrfToken(null);
  return () => { Object.assign(globalThis, previous); setMemberCsrfToken(null); };
}
const member = (status = 'approved', role = 'member') => ({ id: 'member-id', email: 'member@example.com', role, status, workspaceSlug: status === 'approved' ? 'member-space' : null });
const session = (account = null) => ({ authenticated: !!account, csrfToken: account ? 'csrf-value' : null, member: account });

test('tenant participant requests and member mutations use separate paths and CSRF boundaries', async () => {
  const restore = environment(); const requests = [];
  try {
    globalThis.location.pathname = '/v/wine-party/';
    globalThis.fetch = async (url, init) => { requests.push([url, init]); return Response.json({ ok: true }); };
    setMemberCsrfToken('secret-token');
    assert.equal(apiPath('/bootstrap'), '/v/wine-party/api/bootstrap');
    assert.equal(apiPath('/members/session'), '/api/members/session');
    await api('/activities/byob/answer', 'PUT', { ranking: ['a'] });
    await api('/members/requests/a/approve', 'POST', {});
    await api('/admin/candidates/a/photo', 'PUT', new FormData());
    assert.equal(requests[0][1].headers['X-Member-CSRF'], undefined);
    assert.equal(requests[1][0], '/api/members/requests/a/approve');
    assert.equal(requests[1][1].headers['X-Member-CSRF'], 'secret-token');
    assert.equal(requests[2][0], '/v/wine-party/api/admin/candidates/a/photo');
    assert.equal(requests[2][1].headers['X-Member-CSRF'], 'secret-token');
    assert.equal(requests[2][1].headers['Content-Type'], undefined);
  } finally { restore(); }
});

test('photo upload keeps multipart data and sends the member CSRF token', async () => {
  const restore = environment(); const previous = globalThis.XMLHttpRequest; let sent;
  globalThis.XMLHttpRequest = class {
    upload = {}; headers = {};
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(form) { sent = this; this.form = form; this.status = 201; this.response = { candidate: { id: 'wine' } }; this.onload(); }
  };
  try {
    uploadApi.setMemberCsrfToken('photo-csrf');
    uploadApi.setMemberWorkspaceSlug('photo-owner');
    await uploadApi.sendPhoto({ id: 'upload-id', revision: 7, name: 'Wine' }, new File(['image'], 'wine.jpg', { type: 'image/jpeg' }), () => {});
    assert.equal(sent.url, '/v/photo-owner/api/admin/candidates'); assert.equal(sent.method, 'POST');
    assert.equal(sent.headers['X-Member-CSRF'], 'photo-csrf'); assert.equal(sent.headers['Content-Type'], undefined);
    assert.equal(sent.form.get('file').name, 'wine.jpg'); assert.equal(sent.form.get('revision'), '7');
  } finally { globalThis.XMLHttpRequest = previous; uploadApi.setMemberCsrfToken(null); restore(); }
});

test('standalone root and admin routes are enabled only after an explicit mode fallback', () => {
  const restore = environment(); let app;
  try {
    for (const path of ['/', '/admin', '/v/owner']) {
      globalThis.location.pathname = path; app = mount(uploadApi.App); let tree = app.render();
      if (path.startsWith('/v/')) assert.equal(tree.type.name, 'ParticipantApp');
      else { assert.equal(tree.type.name, 'MemberPortal'); tree.props.onStandalone(); tree = app.render(); assert.equal(tree.type.name, path === '/' ? 'ParticipantApp' : 'Admin'); }
      app.close(); app = null;
    }
  } finally { app?.close(); restore(); }
});

for (const scenario of ['standalone', 'membership', 'unavailable']) test(`member bootstrap mode fallback remains fail-closed (${scenario})`, async () => {
  const restore = environment(); let fallbacks = 0;
  globalThis.fetch = async url => url.endsWith('/mode') ? Response.json({ mode: 'ranked-byob', ...(scenario === 'membership' ? { membership: true } : {}) }) : Response.json({ error: '설정 확인 필요' }, { status: scenario === 'unavailable' ? 503 : 404 });
  const onStandalone = () => { fallbacks++; };
  const app = mount(() => MemberPortal({ onStandalone }));
  try { app.render(); await settle(); app.render(); assert.equal(fallbacks, scenario === 'standalone' ? 1 : 0); }
  finally { app.close(); restore(); }
});

for (const status of ['pending', 'approved']) test(`late initial session cannot overwrite a completed ${status === 'pending' ? 'signup' : 'login'}`, async () => {
  const restore = environment(); let resolveInitial; let fallbacks = 0;
  globalThis.fetch = async (url, init) => init.method === 'GET' ? new Promise(resolve => { resolveInitial = resolve; }) : Response.json(session(member(status)));
  const onStandalone = () => { fallbacks++; };
  const app = mount(() => MemberPortal({ onStandalone }));
  try {
    let tree = app.render(); if (status === 'pending') { button(tree, '운영자 가입 신청').props.onClick(); tree = app.render(); }
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'email').props.onChange({ target: { value: 'member@example.com' } });
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'password').props.onChange({ target: { value: 'valid-password' } });
    tree = app.render(); nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); await settle();
    resolveInitial(Response.json(session())); await settle(); tree = app.render();
    if (status === 'pending') assert.ok(JSON.stringify(tree).includes('가입 승인 대기 중'));
    else assert.deepEqual(globalThis.location.replacements, ['/admin']);
    assert.equal(fallbacks, 0);
  } finally { app.close(); restore(); }
});

test('standalone admin retains password login, management, password change and logout', async () => {
  const restore = environment(); let loggedIn = false; const requests = [];
  const legacyApi = await import('data:text/javascript;base64,' + Buffer.from(uploadBundle.outputFiles[0].text).toString('base64') + '#standalone-admin');
  globalThis.location.pathname = '/admin';
  globalThis.fetch = async (url, init) => {
    requests.push([url, init]);
    if (url === '/api/admin/login') { loggedIn = true; return Response.json({ ok: true }); }
    if (url === '/api/admin/session' || url === '/api/admin/password') { loggedIn = false; return Response.json({ ok: true }); }
    return loggedIn ? Response.json({ event: { title: 'Legacy event' }, activities: [], participants: [], candidates: [], answers: { byob: [] }, rosterRevision: 1 }) : Response.json({ error: '로그인 필요' }, { status: 401 });
  };
  const app = mount(legacyApi.Admin);
  try {
    app.render(); await settle(); let tree = app.render(); assert.ok(button(tree, '로그인'));
    nodes(tree).find(node => node.type === 'input').props.onChange({ target: { value: 'legacy-password' } }); tree = app.render();
    nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); await settle(); tree = app.render();
    assert.ok(named(tree, 'Progress')); assert.equal(named(tree, 'AdminHeader').props.participantUrl, 'https://vote.example/');
    await named(tree, 'Progress').props.changePassword('legacy-password', 'new-password'); tree = app.render(); assert.ok(button(tree, '로그인'));
    nodes(tree).find(node => node.type === 'input').props.onChange({ target: { value: 'new-password' } }); tree = app.render(); nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); await settle(); tree = app.render();
    named(tree, 'AdminHeader').props.onLogout(); await settle(); tree = app.render(); assert.ok(button(tree, '로그인'));
    assert.ok(requests.some(([url]) => url === '/api/admin/password')); assert.ok(requests.some(([url]) => url === '/api/admin/session'));
  } finally { app.close(); restore(); }
});

test('signup submits once, preserves failed input, then shows pending approval without vote controls', async () => {
  const restore = environment(); let fail = true; const requests = [];
  globalThis.fetch = async (url, init) => { requests.push([url, init]); if (init.method === 'GET') return Response.json(session()); return fail ? Response.json({ error: '일시적 연결 오류' }, { status: 503 }) : Response.json(session(member('pending'))); };
  const app = mount(MemberPortal);
  try {
    app.render(); await settle(); let tree = app.render(); button(tree, '운영자 가입 신청').props.onClick(); tree = app.render();
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'email').props.onChange({ target: { value: 'member@example.com' } });
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'password').props.onChange({ target: { value: 'valid-password' } });
    tree = app.render(); const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit;
    submit({ preventDefault }); submit({ preventDefault }); await settle(); tree = app.render();
    assert.equal(requests.filter(([url]) => url.endsWith('/signup')).length, 1);
    assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.name === 'password').props.value, 'valid-password');
    fail = false; nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); await settle(); tree = app.render();
    assert.ok(JSON.stringify(tree).includes('가입 승인 대기 중')); assert.equal(named(tree, 'Admin'), undefined);
    assert.ok(button(tree, '승인 상태 확인')); assert.ok(button(tree, '로그아웃'));
    assert.deepEqual(JSON.parse(requests.at(-1)[1].body), { email: 'member@example.com', password: 'valid-password' });
  } finally { app.close(); restore(); }
});

test('approved member enters own admin, settings hides approvals from ordinary members', async () => {
  const restore = environment(); globalThis.fetch = async () => Response.json(session(member())); const app = mount(MemberPortal);
  let settings;
  try {
    globalThis.location.pathname = '/admin';
    app.render(); await settle(); let tree = app.render(); const admin = named(tree, 'Admin'); assert.equal(admin.props.member.workspaceSlug, 'member-space');
    admin.props.onSettings(); tree = app.render(); const props = named(tree, 'MemberSettings').props;
    settings = mount(() => MemberSettings(props)); const settingsTree = settings.render();
    assert.equal(named(settingsTree, 'MembershipRequests'), undefined); assert.ok(named(settingsTree, 'PasswordChange')); assert.ok(button(settingsTree, '로그아웃'));
    settings.close(); settings = mount(() => MemberSettings({ ...props, member: member('approved', 'owner') })); assert.ok(named(settings.render(), 'MembershipRequests'));
  } finally { settings?.close(); app.close(); restore(); }
});

test('root immediately shows login without a public event shortcut and redirects approved login', async () => {
  const restore = environment(); globalThis.fetch = async (url, init) => Response.json(init.method === 'GET' ? session() : session(member())); const app = mount(MemberPortal);
  try {
    let tree = app.render(); assert.ok(button(tree, '로그인')); assert.equal(nodes(tree).filter(node => node.type === 'a' && node.props.href === '/v/owner').length, 0);
    await settle(); tree = app.render();
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'email').props.onChange({ target: { value: 'member@example.com' } });
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'password').props.onChange({ target: { value: 'valid-password' } });
    tree = app.render(); nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); await settle();
    assert.deepEqual(globalThis.location.replacements, ['/admin']);
  } finally { app.close(); restore(); }
});

test('approval mail link preserves the settings intent through owner login without approving', async () => {
  const restore = environment(); const requests = [];
  globalThis.location.pathname = '/admin'; globalThis.location.search = '?settings=approvals';
  globalThis.fetch = async (url, init) => { requests.push([url, init.method]); return Response.json(init.method === 'GET' ? session() : session(member('approved', 'owner'))); };
  const app = mount(MemberPortal);
  try {
    let tree = app.render(); assert.ok(button(tree, '로그인')); assert.equal(named(tree, 'MemberSettings'), undefined);
    await settle(); tree = app.render();
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'email').props.onChange({ target: { value: 'owner@example.com' } });
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'password').props.onChange({ target: { value: 'valid-password' } });
    tree = app.render(); nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); await settle();
    assert.deepEqual(globalThis.location.replacements, ['/admin?settings=approvals']);
    assert.deepEqual(requests.filter(([, method]) => method !== 'GET'), [['/api/members/login', 'POST']]);
  } finally { app.close(); restore(); }
});

for (const account of [member('approved', 'owner'), member(), member('pending'), member('rejected')]) test(`approval intent opens settings only for approved owner (${account.role}/${account.status})`, async () => {
  const restore = environment(); const requests = []; let settings;
  globalThis.location.pathname = '/admin'; globalThis.location.search = '?settings=approvals';
  globalThis.fetch = async (url, init) => { requests.push([url, init.method]); return Response.json(url.endsWith('/requests') ? { requests: [] } : session(account)); };
  const app = mount(MemberPortal);
  try {
    app.render(); await settle(); app.render(); let tree = app.render();
    const props = named(tree, 'MemberSettings')?.props;
    if (account.role === 'owner' && account.status === 'approved') {
      assert.ok(props); settings = mount(() => MemberSettings(props)); assert.ok(named(settings.render(), 'MembershipRequests'));
      props.onClose(); tree = app.render(); assert.equal(named(tree, 'MemberSettings'), undefined);
    } else assert.equal(props, undefined);
    assert.ok(requests.every(([, method]) => method === 'GET'));
  } finally { settings?.close(); app.close(); restore(); }
});

test('logout returns to the root login and clears the previous vote title', async () => {
  const restore = environment(); globalThis.location.pathname = '/admin'; globalThis.fetch = async (url, init) => Response.json(init.method === 'GET' ? session(member()) : { ok: true }); const app = mount(MemberPortal);
  try {
    app.render(); await settle(); let tree = app.render(); named(tree, 'Admin').props.onSettings(); tree = app.render();
    globalThis.document.title = 'Previous event · 관리자';
    await named(tree, 'MemberSettings').props.onLogout();
    assert.deepEqual(globalThis.location.replacements, ['/']); assert.equal(globalThis.document.title, 'BYOB 와인 투표 · 운영자 로그인');
  } finally { app.close(); restore(); }
});

test('admin reads and writes remain pinned to the original member despite a changed session cookie', async () => {
  const restore = environment(); const requests = [];
  try {
    const isolated = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64') + '#account-scope-test');
    globalThis.location.pathname = '/admin'; isolated.setMemberWorkspaceSlug('original-account'); isolated.setMemberWorkspaceSlug('another-account'); isolated.setMemberCsrfToken('original-session');
    globalThis.fetch = async (url, init) => { requests.push([url, init]); return Response.json({ ok: true }); };
    await isolated.api('/admin/state'); await isolated.api('/admin/settings', 'PATCH', { event: { title: 'A draft' } });
    assert.deepEqual(requests.map(([url]) => url), ['/v/original-account/api/admin/state', '/v/original-account/api/admin/settings']);
    assert.ok(requests.every(([, init]) => init.headers['X-Member-CSRF'] === 'original-session'));
  } finally { restore(); }
});

test('owner approval lists only pending requests and guards duplicate decisions', async () => {
  const restore = environment(); const requests = []; let approved = false;
  globalThis.fetch = async (url, init) => { requests.push([url, init]); if (init.method === 'POST') { approved = true; return Response.json({ ok: true }); } return Response.json({ requests: [{ ...member(approved ? 'approved' : 'pending'), createdAt: '2026-11-21T10:00:00Z' }, { ...member('approved'), id: 'other-id', email: 'other@example.com', createdAt: '2026-11-20T10:00:00Z' }] }); };
  const app = mount(() => MembershipRequests({ onSessionEnded() {} }));
  try {
    setMemberCsrfToken('csrf'); app.render(); await settle(); let tree = app.render();
    assert.equal(nodes(tree).filter(node => node.type === 'li').length, 1);
    const approve = button(tree, '승인'); approve.props.onClick(); approve.props.onClick(); await settle(); tree = app.render();
    const decisions = requests.filter(([, init]) => init.method === 'POST'); assert.equal(decisions.length, 1); assert.equal(decisions[0][0], '/api/members/requests/member-id/approve'); assert.equal(decisions[0][1].headers['X-Member-CSRF'], 'csrf');
    assert.ok(JSON.stringify(tree).includes('승인 대기 중인 가입 신청이 없습니다.'));
  } finally { app.close(); restore(); }
});
