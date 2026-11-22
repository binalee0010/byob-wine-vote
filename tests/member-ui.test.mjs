import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export {default as MemberPortal, PasswordReset, MemberSettings, MembershipRequests} from './MemberPortal'; export {api,apiPath,setMemberCsrfToken,setMemberWorkspaceSlug} from './api'; export {default as MemberPolls} from './MemberPolls'; export {candidateNameChanges,passwordChangeError,progressServerFields,progressDraftChanges,progressSettingsUpdate} from './forms'; export {submissionStatusText} from './format';`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'member-test-hooks', setup(builder) {
  builder.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'test' }));
  builder.onLoad({ filter: /^hooks$/, namespace: 'test' }, () => ({ contents: `export const useState=v=>globalThis.memberHooks.state(v);export const useRef=v=>globalThis.memberHooks.memo(()=>({current:v}),[]);export const useEffect=(fn,deps)=>globalThis.memberHooks.effect(fn,deps);export const useLayoutEffect=useEffect;export const useCallback=(fn,deps)=>globalThis.memberHooks.memo(()=>fn,deps);export const useId=()=>globalThis.memberHooks.memo(()=> 'member-settings',[]);` }));
  builder.onResolve({ filter: /^\.\/Admin$/ }, () => ({ path: 'admin', namespace: 'test' }));
  builder.onLoad({ filter: /^admin$/, namespace: 'test' }, () => ({ contents: `export default function Admin(){return null} export function PasswordChange(){return null}` }));
  builder.onResolve({ filter: /^react\/jsx-runtime$/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
} }] });
const { MemberPortal, PasswordReset, MemberSettings, MembershipRequests, MemberPolls, candidateNameChanges, passwordChangeError, progressServerFields, progressDraftChanges, progressSettingsUpdate, submissionStatusText, api, apiPath, setMemberCsrfToken, setMemberWorkspaceSlug } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const uploadBundle = await build({ stdin: { contents: `export {default as Admin,sendPhoto,PasswordChange,Candidates,Participants,Progress,RankedResponses} from './Admin';export {default as App,PhotoDialog} from './App'; export {default as CandidatePhoto} from './CandidatePhoto';export {default as DestructiveAction} from './DestructiveAction';export {setMemberCsrfToken,setMemberWorkspaceSlug} from './api';`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'legacy-test-hooks', setup(builder) {
  builder.onResolve({ filter: /^qrcode$/ }, () => ({ path: 'qr', namespace: 'test' }));
  builder.onLoad({ filter: /^qr$/, namespace: 'test' }, () => ({ contents: `export default {toDataURL:async value=>{globalThis.memberQrCalls?.push(value);return 'data:image/png;base64,c2hvcnQ='}}` }));
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
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, location: globalThis.location, history: globalThis.history, memberHooks: globalThis.memberHooks };
  globalThis.window = { setTimeout, clearTimeout }; globalThis.document = { activeElement: null }; globalThis.location = { pathname: '/', search: '', hash: '', href: 'https://vote.example/', origin: 'https://vote.example', assignments: [], assign(path) { this.assignments.push(path); }, replacements: [], replace(path) { this.replacements.push(path); } };
  globalThis.history = { state: null, replacements: [], replaceState(state, title, path) { this.replacements.push(path); } };
  setMemberCsrfToken(null);
  return () => { Object.assign(globalThis, previous); setMemberCsrfToken(null); };
}
const member = (status = 'approved', role = 'member') => ({ id: 'member-id', email: 'member@example.com', role, status, workspaceSlug: status === 'approved' ? 'member-space' : null });
const session = (account = null) => ({ authenticated: !!account, csrfToken: account ? 'csrf-value' : null, member: account });

test('login keeps only its title, credentials and account actions', async () => {
  const restore = environment(); globalThis.fetch = async () => Response.json(session()); const app = mount(MemberPortal);
  try {
    const tree = app.render(); const text = JSON.stringify(tree);
    assert.deepEqual(nodes(tree).filter(node => node.type === 'h2').map(node => node.props.children), ['로그인']);
    assert.ok(button(tree, '가입 신청')); assert.ok(button(tree, '비밀번호 재설정'));
    assert.ok(!text.includes('투표 운영자')); assert.ok(!text.includes('투표 참가자는')); assert.ok(!text.includes('나만의 투표'));
  } finally { await settle(); app.close(); restore(); }
});

for (const source of ['fragment', 'query']) test(`reset link opens new password form and removes its ${source} token without fetching the session`, async () => {
  const restore = environment(); const requests = [];
  globalThis.location.search = source === 'query' ? '?reset=secret&keep=yes' : '?keep=yes';
  globalThis.location.hash = source === 'fragment' ? '#reset=secret' : '';
  globalThis.location.href = globalThis.location.origin + '/' + globalThis.location.search + globalThis.location.hash;
  globalThis.fetch = async url => { requests.push(url); return Response.json(session(member())); };
  const app = mount(MemberPortal);
  try {
    const tree = app.render(); await settle(); const reset = named(tree, 'PasswordReset');
    assert.equal(reset.props.token, 'secret'); assert.deepEqual(globalThis.history.replacements, ['/?keep=yes']);
    assert.deepEqual(requests, []); assert.equal(named(tree, 'Admin'), undefined);
    reset.props.onComplete(); const login = app.render(); assert.ok(button(login, '로그인'));
    assert.ok(JSON.stringify(login).includes('새 비밀번호로 로그인해 주세요.'));
  } finally { await settle(); app.close(); restore(); }
});

test('reset request prevents duplicate sends, preserves failed email and reports a generic result', async () => {
  const restore = environment(); const requests = []; let fail = true; let backs = 0;
  globalThis.fetch = async (url, init) => { requests.push([url, init]); return fail ? Response.json({ error: '잠시 후 다시 시도해 주세요.', code: 'mail_unavailable' }, { status: 503 }) : Response.json({ ok: true }); };
  const app = mount(() => PasswordReset({ token: null, onBack: () => { backs++; }, onRequestAgain() {}, onComplete() { assert.fail('request must not finish a reset'); } }));
  try {
    let tree = app.render(); const input = nodes(tree).find(node => node.type === 'input'); assert.equal(input.props.autoFocus, true);
    input.props.onChange({ target: { value: 'member@example.com' } }); tree = app.render();
    const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit;
    const first = submit({ preventDefault }); submit({ preventDefault });
    assert.equal(button(app.render(), '로그인으로 돌아가기').props.disabled, true); await first; tree = app.render();
    assert.equal(requests.length, 1); assert.equal(nodes(tree).find(node => node.type === 'input').props.value, 'member@example.com');
    assert.ok(JSON.stringify(tree).includes('잠시 후 다시 시도해 주세요.'));
    fail = false; await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); tree = app.render();
    assert.equal(requests.at(-1)[0], '/api/members/password-reset/request'); assert.deepEqual(JSON.parse(requests.at(-1)[1].body), { email: 'member@example.com' });
    assert.ok(JSON.stringify(tree).includes('가입한 이메일이면')); assert.equal(nodes(tree).filter(node => node.type === 'form').length, 0);
    button(tree, '다시 요청').props.onClick(); tree = app.render();
    assert.equal(nodes(tree).find(node => node.type === 'input').props.value, 'member@example.com');
    button(tree, '로그인으로 돌아가기').props.onClick(); assert.equal(backs, 1);
  } finally { app.close(); restore(); }
});

for (const invalid of [false, true]) test(`new password reset ${invalid ? 'offers a fresh link for expired or used tokens' : 'submits once and completes without automatic login'}`, async () => {
  const restore = environment(); const requests = []; let completed = 0; let requestedAgain = 0;
  globalThis.fetch = async (url, init) => { requests.push([url, init]); return invalid ? Response.json({ error: '잘못된 링크', code: 'invalid_reset_token' }, { status: 400 }) : Response.json({ ok: true }); };
  const app = mount(() => PasswordReset({ token: 'single-use-token', onBack() {}, onRequestAgain() { requestedAgain++; }, onComplete() { completed++; } }));
  try {
    let tree = app.render(); const input = nodes(tree).find(node => node.type === 'input');
    assert.equal(input.props.minLength, undefined); assert.equal(input.props.maxLength, undefined); assert.equal(input.props.required, true); assert.equal(input.props.autoComplete, 'new-password'); assert.equal(input.props.autoFocus, true);
    assert.equal(button(tree, '비밀번호 변경').props.disabled, true);
    input.props.onChange({ target: { value: '1234' } }); tree = app.render();
    assert.equal(button(tree, '비밀번호 변경').props.disabled, false);
    const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit; const first = submit({ preventDefault }); submit({ preventDefault }); await first; tree = app.render();
    assert.equal(requests.length, 1); assert.equal(requests[0][0], '/api/members/password-reset/confirm');
    assert.deepEqual(JSON.parse(requests[0][1].body), { token: 'single-use-token', newPassword: '1234' });
    assert.equal(completed, invalid ? 0 : 1); assert.equal(nodes(tree).find(node => node.type === 'input')?.props.value ?? '', '');
    if (invalid) { assert.ok(JSON.stringify(tree).includes('만료되었거나 이미 사용되었습니다')); button(tree, '새 재설정 메일 받기').props.onClick(); assert.equal(requestedAgain, 1); }
  } finally { app.close(); restore(); }
});

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
    let tree = app.render(); if (status === 'pending') { button(tree, '가입 신청').props.onClick(); tree = app.render(); }
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
    return loggedIn ? Response.json({ event: { title: 'Legacy event' }, activities: [{ id: 'byob', title: 'Legacy question', revision: 1, status: 'waiting' }], participants: [], candidates: [], submittedCount: 0, rosterRevision: 1 }) : Response.json({ error: '로그인 필요' }, { status: 401 });
  };
  const app = mount(legacyApi.Admin);
  try {
    app.render(); await settle(); let tree = app.render(); assert.ok(button(tree, '로그인'));
    assert.equal(globalThis.document.title, '투표 관리');
    const header = named(tree, 'AdminHeader'); assert.equal(header.props.title, '투표 관리');
    assert.equal(nodes(tree).filter(node => node.type === 'h1').length, 0);
    assert.equal(nodes(header.type(header.props)).filter(node => node.type === 'h1').length, 1);
    nodes(tree).find(node => node.type === 'input').props.onChange({ target: { value: 'legacy-password' } }); tree = app.render();
    nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); await settle(); tree = app.render();
    assert.ok(named(tree, 'Progress')); assert.equal(named(tree, 'AdminHeader').props.participantUrl, 'https://vote.example/');
    assert.equal(named(tree, 'AdminHeader').props.title, 'Legacy event');
    assert.equal(globalThis.document.title, 'Legacy event · 투표 관리');
    const loggedInHeader = named(tree, 'AdminHeader');
    assert.equal(nodes(loggedInHeader.type(loggedInHeader.props)).filter(node => node.type === 'button' && node.props.children === '로그아웃').length, 1);
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
    app.render(); await settle(); let tree = app.render(); button(tree, '가입 신청').props.onClick(); tree = app.render();
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'email').props.onChange({ target: { value: 'member@example.com' } });
    const password = nodes(tree).find(node => node.type === 'input' && node.props.name === 'password');
    assert.equal(password.props.minLength, undefined); assert.equal(password.props.maxLength, undefined); assert.equal(password.props.required, true);
    password.props.onChange({ target: { value: '1234' } });
    tree = app.render(); const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit;
    submit({ preventDefault }); submit({ preventDefault }); await settle(); tree = app.render();
    assert.equal(requests.filter(([url]) => url.endsWith('/signup')).length, 1);
    assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.name === 'password').props.value, '1234');
    fail = false; nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); await settle(); tree = app.render();
    assert.ok(JSON.stringify(tree).includes('가입 승인 대기 중')); assert.equal(named(tree, 'Admin'), undefined);
    assert.ok(button(tree, '승인 상태 확인')); assert.ok(button(tree, '로그아웃'));
    assert.deepEqual(JSON.parse(requests.at(-1)[1].body), { email: 'member@example.com', password: '1234' });
  } finally { app.close(); restore(); }
});

test('approved member enters own admin, settings hides approvals from ordinary members', async () => {
  const restore = environment(); globalThis.fetch = async () => Response.json(session(member())); const app = mount(MemberPortal);
  let settings;
  try {
    globalThis.location.pathname = '/admin/p/member-space';
    app.render(); await settle(); let tree = app.render(); const admin = named(tree, 'Admin'); assert.equal(admin.props.member.workspaceSlug, 'member-space');
    admin.props.onSettings(); tree = app.render(); const props = named(tree, 'MemberSettings').props;
    settings = mount(() => MemberSettings(props)); const settingsTree = settings.render();
    assert.equal(named(settingsTree, 'MembershipRequests'), undefined); assert.ok(named(settingsTree, 'PasswordChange')); assert.ok(button(settingsTree, '로그아웃'));
    assert.ok(nodes(settingsTree).some(node => node.type === 'small' && node.props.children === '회원'));
    settings.close(); settings = mount(() => MemberSettings({ ...props, member: member('approved', 'owner') })); const ownerSettings = settings.render(); assert.ok(named(ownerSettings, 'MembershipRequests'));
    assert.ok(nodes(ownerSettings).some(node => node.type === 'small' && node.props.children === '관리자'));
  } finally { settings?.close(); app.close(); restore(); }
});

test('root immediately shows login without a public event shortcut and redirects approved login', async () => {
  const restore = environment(); globalThis.fetch = async (url, init) => Response.json(init.method === 'GET' ? session() : session(member())); const app = mount(MemberPortal);
  try {
    let tree = app.render(); assert.ok(button(tree, '로그인')); assert.equal(nodes(tree).filter(node => node.type === 'a' && node.props.href === '/v/owner').length, 0);
    await settle(); tree = app.render();
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'email').props.onChange({ target: { value: 'member@example.com' } });
    nodes(tree).find(node => node.type === 'input' && node.props.name === 'password').props.onChange({ target: { value: 'valid-password' } });
    tree = app.render(); const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit;
    await submit({ preventDefault }); tree = app.render();
    assert.deepEqual(globalThis.location.replacements, ['/admin']);
    assert.equal(nodes(tree).find(node => node.type === 'form'), undefined);
    assert.ok(nodes(tree).some(node => node.props?.role === 'status'));
    await submit({ preventDefault }); assert.deepEqual(globalThis.location.replacements, ['/admin']);
  } finally { app.close(); restore(); }
});

for (const result of ['approved', 'guest', 'failure']) test(`admin waits for its initial session without flashing login (${result})`, async () => {
  const restore = environment(); let resolveSession;
  globalThis.location.pathname = '/admin';
  globalThis.fetch = () => new Promise(resolve => { resolveSession = resolve; });
  const app = mount(MemberPortal);
  try {
    let tree = app.render(); assert.equal(nodes(tree).find(node => node.type === 'form'), undefined);
    assert.ok(nodes(tree).some(node => node.props?.role === 'status'));
    resolveSession(result === 'failure' ? Response.json({ error: '연결 오류' }, { status: 503 }) : Response.json(session(result === 'approved' ? member() : null)));
    await settle(); tree = app.render();
    if (result === 'approved') { assert.ok(named(tree, 'MemberPolls')); assert.equal(nodes(tree).find(node => node.type === 'form'), undefined); }
    else { assert.ok(button(tree, '로그인')); if (result === 'failure') assert.ok(JSON.stringify(tree).includes('연결 오류')); }
  } finally { app.close(); restore(); }
});

test('login failure preserves credentials and unlocks a single retry before navigation', async () => {
  const restore = environment(); const requests = []; let fail = true;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'GET') return Response.json(session());
    requests.push([url, init]);
    return fail ? Response.json({ error: '로그인 실패' }, { status: 401 }) : Response.json(session(member()));
  };
  const app = mount(MemberPortal);
  try {
    app.render(); await settle(); let tree = app.render();
    for (const [name, value] of [['email', 'member@example.com'], ['password', 'valid-password']]) nodes(tree).find(node => node.type === 'input' && node.props.name === name).props.onChange({ target: { value } });
    tree = app.render(); const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit;
    const first = submit({ preventDefault }); await submit({ preventDefault }); await first;
    tree = app.render(); assert.equal(requests.length, 1); assert.ok(JSON.stringify(tree).includes('로그인 실패'));
    assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.name === 'password').props.value, 'valid-password');
    assert.equal(nodes(tree).find(node => node.type === 'fieldset').props.disabled, false);
    fail = false; await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault });
    assert.equal(requests.length, 2); assert.equal(nodes(app.render()).find(node => node.type === 'form'), undefined);
  } finally { app.close(); restore(); }
});

for (const [path, target] of [['/admin/p/saved-poll', '/admin/p/saved-poll'], ['/admin/p/%2F%2Fevil.example', '/admin']]) test(`login keeps only a validated bookmarked poll path (${path})`, async () => {
  const restore = environment(); globalThis.location.pathname = path; globalThis.location.search = '?next=https://evil.example';
  globalThis.fetch = async (url, init) => Response.json(init.method === 'GET' ? session() : session(member()));
  const app = mount(MemberPortal);
  try {
    app.render(); await settle(); let tree = app.render();
    for (const [name, value] of [['email', 'member@example.com'], ['password', '1234']]) nodes(tree).find(node => node.type === 'input' && node.props.name === name).props.onChange({ target: { value } });
    tree = app.render(); await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault });
    assert.deepEqual(globalThis.location.replacements, [target]); assert.equal(nodes(app.render()).find(node => node.type === 'form'), undefined);
  } finally { app.close(); restore(); }
});

test('approval mail link preserves the settings intent through owner login without approving', async () => {
  const restore = environment(); const requests = [];
  globalThis.location.pathname = '/admin'; globalThis.location.search = '?settings=approvals';
  globalThis.fetch = async (url, init) => { requests.push([url, init.method]); return Response.json(init.method === 'GET' ? session() : session(member('approved', 'owner'))); };
  const app = mount(MemberPortal);
  try {
    let tree = app.render(); assert.equal(button(tree, '로그인'), undefined); assert.equal(named(tree, 'MemberSettings'), undefined);
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
    app.render(); await settle(); let tree = app.render(); named(tree, 'MemberPolls').props.onSettings(); tree = app.render();
    globalThis.document.title = 'Previous event · 투표 관리';
    await named(tree, 'MemberSettings').props.onLogout();
    assert.deepEqual(globalThis.location.replacements, ['/']); assert.equal(globalThis.document.title, '와인 인기투표 · 로그인');
  } finally { app.close(); restore(); }
});

for (const path of ['/admin', '/admin/p/member-space']) test(`visible host logout revokes once and returns to login (${path})`, async () => {
  const restore = environment(); globalThis.location.pathname = path; let finish; const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push([url, init]);
    return init.method === 'GET' ? Response.json(session(member())) : new Promise(resolve => { finish = resolve; });
  };
  const app = mount(MemberPortal);
  try {
    app.render(); await settle(); let tree = app.render(); const screenName = path === '/admin' ? 'MemberPolls' : 'Admin';
    assert.equal(named(tree, 'MemberSettings'), undefined);
    const screen = named(tree, screenName); assert.equal(typeof screen.props.onLogout, 'function');
    screen.props.onLogout(); screen.props.onLogout(); tree = app.render();
    assert.equal(named(tree, screenName).props.loggingOut, true);
    const deletes = requests.filter(([, init]) => init.method === 'DELETE'); assert.equal(deletes.length, 1);
    assert.equal(deletes[0][0], '/api/members/session'); assert.equal(deletes[0][1].headers['X-Member-CSRF'], 'csrf-value');
    finish(Response.json({ ok: true })); await settle(); tree = app.render();
    assert.deepEqual(globalThis.location.replacements, ['/']); assert.ok(button(tree, '로그인'));
    assert.equal(named(tree, screenName), undefined); assert.equal(globalThis.document.title, '와인 인기투표 · 로그인');
  } finally { app.close(); restore(); }
});

for (const path of ['/admin', '/admin/p/member-space']) test(`failed host logout remains visible and can retry (${path})`, async () => {
  const restore = environment(); globalThis.location.pathname = path;
  globalThis.fetch = async (url, init) => init.method === 'GET' ? Response.json(session(member())) : Response.json({ error: '로그아웃 실패' }, { status: 503 });
  const app = mount(MemberPortal);
  try {
    app.render(); await settle(); let tree = app.render(); const screenName = path === '/admin' ? 'MemberPolls' : 'Admin';
    named(tree, screenName).props.onLogout(); await settle(); tree = app.render();
    assert.equal(named(tree, screenName).props.sessionError, '로그아웃 실패'); assert.equal(named(tree, screenName).props.loggingOut, false);
    assert.deepEqual(globalThis.location.replacements, []); assert.equal(named(tree, 'MemberSettings'), undefined);
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

test('poll list opens independent polls and creates once with a stable retry request ID', async () => {
  const restore = environment(); const requests = []; let fail = true; let settings = 0;
  globalThis.fetch = async (url, init) => {
    requests.push([url, init]);
    if (init.method === 'GET') return Response.json({ polls: [{ slug: 'old-poll', title: '보존된 첫 투표', status: 'closed' }, { slug: 'other-poll', title: '점심 메뉴', status: 'waiting' }] });
    return fail ? Response.json({ error: '잠시 후 다시 시도' }, { status: 503 }) : Response.json({ poll: { slug: 'new-poll', title: '여행지', status: 'waiting' } });
  };
  const onSettings = () => { settings++; }; const onSessionEnded = () => { assert.fail('session remains active'); };
  const app = mount(() => MemberPolls({ onSettings, onSessionEnded }));
  try {
    let tree = app.render(); assert.ok(nodes(tree).some(node => node.props?.role === 'status')); await settle(); tree = app.render();
    assert.deepEqual(nodes(tree).filter(node => node.type === 'a').map(node => node.props.href), ['/admin/p/old-poll', '/admin/p/other-poll']);
    assert.deepEqual(nodes(tree).filter(node => node.type === 'a').map(node => node.props.children), ['보존된 첫 투표', '점심 메뉴']);
    assert.equal(named(tree, 'DestructiveAction'), undefined); assert.equal(button(tree, '삭제'), undefined);
    assert.equal(globalThis.document.title, '와인 인기투표 · 내 투표 목록');
    assert.equal(named(tree, 'SiteHeader').props.title, '와인 인기투표');
    assert.equal(nodes(tree).find(node => node.type === 'input').props.placeholder, undefined);
    const header = named(tree, 'SiteHeader'); button(header, '계정 설정').props.onClick(); assert.equal(settings, 1);
    assert.equal(nodes(header).filter(node => node.type === 'button' && node.props.children === '로그아웃').length, 1);
    nodes(tree).find(node => node.type === 'input').props.onChange({ target: { value: '여행지' } }); tree = app.render();
    const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit;
    setMemberCsrfToken('poll-csrf'); const first = submit({ preventDefault }); await submit({ preventDefault }); await first; tree = app.render();
    assert.equal(requests.filter(([, init]) => init.method === 'POST').length, 1);
    assert.equal(nodes(tree).find(node => node.type === 'input').props.value, '여행지'); assert.equal(button(tree, '투표 만들기').props.disabled, false);
    fail = false; await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); tree = app.render();
    const posts = requests.filter(([, init]) => init.method === 'POST'); assert.equal(posts.length, 2);
    assert.equal(posts[0][1].body, posts[1][1].body); assert.equal(JSON.parse(posts[1][1].body).title, '여행지'); assert.ok(JSON.parse(posts[1][1].body).requestId);
    assert.ok(posts.every(([url, init]) => url === '/api/members/polls' && init.headers['X-Member-CSRF'] === 'poll-csrf'));
    assert.deepEqual(globalThis.location.assignments, ['/admin/p/new-poll']); assert.equal(nodes(tree).find(node => node.type === 'form'), undefined);
    await submit({ preventDefault }); assert.equal(requests.filter(([, init]) => init.method === 'POST').length, 2);
  } finally { app.close(); restore(); }
});

test('selected poll deletion confirms its title, retries failures and returns to the list only for a matching acknowledgement', async () => {
  const restore = environment(); const requests = [];
  const isolated = await import('data:text/javascript;base64,' + Buffer.from(uploadBundle.outputFiles[0].text).toString('base64') + '#poll-deletion');
  const state = { event: { title: '삭제할 와인 모임' }, participantUrl: 'https://vote.example/v/managed-poll', activities: [{ id: 'byob', title: '선택', revision: 1, started: false, status: 'waiting', published: false, resultsLocked: false, resultVisibility: 'private' }], participants: [], submittedCount: 0, rosterRevision: 1, candidates: [], photoCleanupPending: 0 };
  let deletes = 0; let progress; let confirmation;
  globalThis.location.pathname = '/admin/p/managed-poll';
  isolated.setMemberWorkspaceSlug('managed-poll'); isolated.setMemberCsrfToken('delete-csrf');
  globalThis.fetch = async (path, init) => {
    requests.push([path, init]);
    if (init.method === 'GET') { assert.equal(path, '/v/managed-poll/api/admin/state'); return Response.json(state); }
    assert.equal(path, '/api/members/polls/managed-poll'); assert.equal(init.method, 'DELETE');
    assert.equal(init.headers['X-Member-CSRF'], 'delete-csrf'); assert.equal(init.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(init.body), { confirm: 'delete-poll' });
    deletes++;
    return deletes === 1 ? Response.json({ error: '삭제 실패' }, { status: 503 }) : Response.json({ ok: true, slug: deletes === 2 ? 'other-poll' : 'managed-poll' });
  };
  const onSessionEnded = () => assert.fail('session should remain active');
  const app = mount(() => isolated.Admin({ member: member(), pollSlug: 'managed-poll', onSessionEnded }));
  try {
    app.render(); await settle(); const adminTree = app.render();
    assert.equal(button(adminTree, '투표 진행').props['aria-current'], 'page');
    const progressNode = named(adminTree, 'Progress'); progress = mount(() => isolated.Progress(progressNode.props));
    const progressTree = progress.render(); const controls = nodes(progressTree).filter(node => node.type?.name === 'DestructiveAction');
    const deletion = controls.find(node => node.props.label === '투표 삭제'); assert.ok(deletion);
    assert.equal(controls.at(-1), deletion); assert.ok(deletion.props.request.title.includes('‘삭제할 와인 모임’'));
    confirmation = mount(() => isolated.DestructiveAction(deletion.props)); let dialog = confirmation.render();
    button(dialog, '투표 삭제').props.onClick(); dialog = confirmation.render();
    assert.equal(nodes(dialog).find(node => node.type === 'h2').props.children, deletion.props.request.title);
    button(dialog, '취소').props.onClick(); dialog = confirmation.render();
    assert.equal(nodes(dialog).find(node => node.type === 'dialog'), undefined); assert.equal(deletes, 0);
    button(dialog, '투표 삭제').props.onClick(); dialog = confirmation.render();
    const submit = () => nodes(confirmation.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault });
    const first = submit(); await submit(); await first; dialog = confirmation.render();
    assert.equal(deletes, 1); assert.ok(JSON.stringify(dialog).includes('삭제 실패')); assert.ok(nodes(dialog).find(node => node.type === 'dialog'));
    assert.deepEqual(globalThis.location.assignments, []); assert.deepEqual(globalThis.location.replacements, []);
    await submit(); dialog = confirmation.render();
    assert.equal(deletes, 2); assert.ok(JSON.stringify(dialog).includes('삭제 결과를 확인하지 못했습니다.')); assert.ok(nodes(dialog).find(node => node.type === 'dialog'));
    assert.deepEqual(globalThis.location.assignments, []); assert.deepEqual(globalThis.location.replacements, []);
    const success = submit(); await submit(); await success; dialog = confirmation.render();
    assert.equal(deletes, 3); assert.equal(nodes(dialog).find(node => node.type === 'dialog'), undefined);
    assert.deepEqual(globalThis.location.replacements, ['/admin']);
    assert.equal(requests.filter(([, init]) => init.method === 'GET').length, 1);
  } finally { await settle(); confirmation?.close(); progress?.close(); app.close(); isolated.setMemberCsrfToken(null); restore(); }
});

test('standalone poll administration does not offer member poll deletion', async () => {
  const restore = environment(); let progress;
  globalThis.fetch = async () => Response.json({ event: { title: '독립 투표' }, activities: [{ id: 'byob', title: '선택', revision: 1, started: false, status: 'waiting' }], participants: [], submittedCount: 0, rosterRevision: 1, candidates: [], photoCleanupPending: 0 });
  const app = mount(() => uploadApi.Admin());
  try {
    app.render(); await settle(); const progressNode = named(app.render(), 'Progress');
    progress = mount(() => uploadApi.Progress(progressNode.props)); const tree = progress.render();
    assert.equal(nodes(tree).find(node => node.type?.name === 'DestructiveAction' && node.props.label === '투표 삭제'), undefined);
    assert.ok(named(tree, 'PasswordChange'));
  } finally { await settle(); progress?.close(); app.close(); restore(); }
});

test('poll list reloads failed reads and ends an expired member session without creating', async () => {
  const restore = environment(); let calls = 0; let ended = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? Response.json({ error: '연결 실패' }, { status: 503 }) : Response.json({ error: '로그인 필요' }, { status: 401 }); };
  const onSessionEnded = () => { ended++; };
  const app = mount(() => MemberPolls({ onSettings() {}, onSessionEnded }));
  try {
    app.render(); await settle(); let tree = app.render(); assert.ok(button(tree, '다시 불러오기')); assert.equal(button(tree, '투표 만들기').props.disabled, true);
    button(tree, '다시 불러오기').props.onClick(); await settle(); assert.equal(ended, 1); assert.equal(calls, 2);
  } finally { app.close(); restore(); }
});

test('selected poll route pins admin requests and participant links instead of the legacy account poll', async () => {
  const restore = environment(); const requests = [];
  const isolated = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64') + '#selected-poll');
  globalThis.location.pathname = '/admin/p/second-poll';
  globalThis.fetch = async (url, init) => { requests.push([url, init]); return Response.json(session(member())); };
  const app = mount(isolated.MemberPortal);
  try {
    assert.equal(named(app.render(), 'Admin'), undefined); await settle(); let tree = app.render();
    const admin = named(tree, 'Admin'); assert.equal(admin.props.pollSlug, 'second-poll');
    await isolated.api('/admin/state'); await isolated.api('/admin/settings', 'PATCH', { event: { title: '내 두 번째 투표' } });
    assert.deepEqual(requests.slice(1).map(([url]) => url), ['/v/second-poll/api/admin/state', '/v/second-poll/api/admin/settings']);
    assert.equal(requests.at(-1)[1].headers['X-Member-CSRF'], 'csrf-value');
    const adminApp = mount(() => uploadApi.Admin({ ...admin.props }));
    try {
      const adminTree = adminApp.render(); const header = named(adminTree, 'AdminHeader');
      assert.equal(header.props.participantUrl, undefined); assert.equal(header.props.pollListUrl, '/admin');
    } finally { await settle(); adminApp.close(); }
  } finally { app.close(); restore(); }
});

test('sharing, copying, QR and participant preview all use the short URL returned by the selected poll', async () => {
  const restore = environment(); const previousQr = globalThis.memberQrCalls; const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const copied = []; globalThis.memberQrCalls = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied.push(value); } } });
  const participantUrl = 'https://vote.example/v/a2bc3def'; let progress;
  globalThis.fetch = async () => Response.json({ participantUrl, event: { title: '짧은 참가 주소' }, activities: [{ id: 'byob', revision: 1, status: 'waiting', started: false }], participants: [], candidates: [], submittedCount: 0 });
  const app = mount(() => uploadApi.Admin({ member: member(), pollSlug: 'a'.repeat(32), onSettings() {} }));
  try {
    assert.equal(named(app.render(), 'AdminHeader').props.participantUrl, undefined); await settle(); const tree = app.render(); const header = named(tree, 'AdminHeader');
    assert.equal(header.props.participantUrl, participantUrl);
    assert.equal(nodes(header.type(header.props)).find(node => node.type === 'a' && node.props.children === '참가자 화면 보기 ↗').props.href, participantUrl);
    const node = named(tree, 'Progress'); progress = mount(() => node.type(node.props)); progress.render(); await settle(); const progressTree = progress.render();
    const share = nodes(progressTree).find(node => node.type === 'a' && node.props.className === 'share-url'); assert.equal(share.props.href, participantUrl); assert.equal(share.props.children, participantUrl);
    await button(progressTree, '주소 복사').props.onClick(); assert.deepEqual(copied, [participantUrl]); assert.deepEqual(globalThis.memberQrCalls, [participantUrl]);
    assert.equal(nodes(progressTree).find(node => node.type === 'img' && node.props.className === 'qr').props.src, 'data:image/png;base64,c2hvcnQ=');
  } finally { await settle(); progress?.close(); app.close(); globalThis.memberQrCalls = previousQr; if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else delete navigator.clipboard; restore(); }
});

test('password change accepts 1234 and preserves mismatch and nonempty validation', async () => {
  assert.equal(passwordChangeError('old', '1234', '1234'), '');
  assert.ok(passwordChangeError('', '1234', '1234')); assert.ok(passwordChangeError('old', '', '')); assert.ok(passwordChangeError('old', '1234', '5678'));
  const restore = environment(); const changes = [];
  const app = mount(() => uploadApi.PasswordChange({ busy: false, onChangePassword: async (...values) => { changes.push(values); } }));
  try {
    let tree = app.render(); const inputs = nodes(tree).filter(node => node.type === 'input');
    for (const input of inputs) { assert.equal(input.props.minLength, undefined); assert.equal(input.props.maxLength, undefined); assert.equal(input.props.required, true); input.props.onChange({ target: { value: input.props.name === 'currentPassword' ? 'old' : '1234' } }); }
    tree = app.render(); await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); assert.deepEqual(changes, [['old', '1234']]);
  } finally { app.close(); restore(); }
});

test('candidate registration edits names only and keeps existing descriptions out of the form payload', async () => {
  const fields = new FormData(); fields.set('a', '기존 후보'); fields.set('description:a', '수정 설명'); fields.set('b', '다른 후보'); fields.set('description:b', '');
  const original = [{ id: 'a', number: 1, name: '기존 후보', description: '기존 설명', photoUrl: '/photo-a' }, { id: 'b', number: 2, name: '다른 후보', description: '보존할 설명', photoUrl: null }];
  assert.deepEqual(candidateNameChanges(original, fields), []);
  fields.set('a', ' 수정 후보 '); assert.deepEqual(candidateNameChanges(original, fields), [{ id: 'a', name: '수정 후보' }]);
  const legacyFields = new FormData(); legacyFields.set('legacy', 'Ａ 기존 이름 '); legacyFields.set('description:legacy', '새 설명');
  assert.deepEqual(candidateNameChanges([{ id: 'legacy', name: 'Ａ 기존 이름 ', description: '예전 설명' }], legacyFields), []);
  const restore = environment(); const NativeFormData = globalThis.FormData;
  globalThis.FormData = class extends NativeFormData { constructor(form) { super(); for (const [key, value] of Object.entries(form)) this.set(key, value); } };
  try {
    for (const status of ['waiting', 'open', 'closed']) {
      const state = { event: { title: '모임', memo: '보존할 모임 메모' }, participants: [{ id: 'person', name: '참가자' }], activities: [{ id: 'byob', revision: 1, started: status !== 'waiting', status }], candidates: original, photoCleanupPending: 0 };
      const before = structuredClone(state); const requests = [];
      const app = mount(() => uploadApi.Candidates({ state, action: async (path, method, body) => { requests.push({ path, method, body }); return true; }, busy: false, refresh: async () => {}, onUploadBusy() {} }));
      try {
        const tree = app.render();
        assert.equal(named(tree, 'ServerTextInput').props.disabled, status === 'open'); assert.equal(named(tree, 'ServerTextArea'), undefined);
        assert.ok(!JSON.stringify(tree).includes('설명 (선택)')); assert.equal(named(tree, 'CandidatePhotoEditor').props.candidate, original[0]);
        const form = nodes(tree).find(node => node.type === 'form' && node.props.className === 'candidate-names-form');
        assert.equal(nodes(form).filter(node => node.type === 'textarea').length, 0);
        assert.equal(!!button(tree, '와인 정보 저장'), status !== 'open');
        await form.props.onSubmit({ preventDefault, currentTarget: { a: '수정 후보', b: '다른 후보', 'description:a': '', 'description:b': '덮어쓰지 않을 설명' } });
        assert.deepEqual(requests, status === 'open' ? [] : [{ path: '/admin/candidates/names', method: 'PUT', body: { names: [{ id: 'a', name: '수정 후보' }], revision: 1 } }]);
        assert.deepEqual(state, before);
        if (status !== 'waiting') {
          assert.equal(button(tree, '삭제'), undefined); assert.equal(nodes(tree).filter(node => node.type === 'input' && node.props.type === 'file').length, 0);
        } else assert.equal(nodes(tree).filter(node => node.type === 'textarea').length, 1);
      } finally { app.close(); }
    }
    const candidate = { ...original[0], photoUrl: null }; let opened;
    const photo = uploadApi.CandidatePhoto({ candidate, onPhoto: next => { opened = next; } });
    assert.equal(photo.type, 'button'); assert.equal(photo.props['aria-label'], '기존 후보 설명 보기'); photo.props.onClick(); assert.equal(opened, candidate);
    const app = mount(() => uploadApi.PhotoDialog({ photo: candidate, onClose() {} }));
    try { assert.ok(JSON.stringify(app.render()).includes('기존 설명')); } finally { app.close(); }
  } finally { globalThis.FormData = NativeFormData; restore(); }
});

test('submission status is read-only and aggregate controls use server counts without individual answers', async () => {
  const restore = environment();
  const state = {
    event: { title: '독립 투표' },
    activities: [{ id: 'byob', title: '선택해 주세요', revision: 1, started: false, status: 'waiting', published: false, resultsLocked: false, resultVisibility: 'private', votingMethod: 'winner' }],
    participants: [{ id: 'joined-a', name: '참여한 민수', submitted: { byob: true } }, { id: 'joined-b', name: '참여한 서연', submitted: { byob: false } }],
    submittedCount: 1, rosterRevision: 7, candidates: [], byobResults: [], photoCleanupPending: 0,
  };
  Object.defineProperty(state, 'answers', { get() { assert.fail('individual answers must never be read'); } });
  try {
    const tree = uploadApi.Participants({ state }); const text = JSON.stringify(tree);
    assert.ok(text.includes('제출 현황')); assert.ok(text.includes('참여한 민수')); assert.ok(text.includes('참여한 서연'));
    assert.ok(text.includes(submissionStatusText(true))); assert.ok(text.includes(submissionStatusText(false)));
    assert.equal(nodes(tree).filter(node => ['form', 'input', 'textarea', 'button', 'select'].includes(node.type)).length, 0);
    assert.equal(named(tree, 'DestructiveAction'), undefined);
    assert.ok(JSON.stringify(uploadApi.Participants({ state: { ...state, participants: [] } })).includes('아직 참여한 사람이 없습니다.'));
    const progress = mount(() => uploadApi.Progress({ state, action: async () => true, busy: false }));
    try {
      const progressTree = progress.render(); const activity = named(progressTree, 'ActivityControl');
      assert.equal(activity.props.count, 1); assert.equal(activity.props.total, 2);
      assert.ok(!JSON.stringify(progressTree).includes('참가 방식'));
      const reset = nodes(progressTree).find(node => node.type?.name === 'DestructiveAction' && node.props.label === '전체 초기화'); assert.ok(reset.props.request.description.includes('이 투표의 참가 기록과 세션'));
      assert.equal(reset.props.request.body.expectedRosterRevision, 7);
      assert.ok(!JSON.stringify(progressTree).includes('이전에 저장된 기록'));
    } finally { await settle(); progress.close(); }
    const results = mount(() => uploadApi.RankedResponses({ state, action: async () => true, busy: false }));
    try {
      const resultsTree = results.render(); const total = nodes(resultsTree).find(node => node.type === 'p' && Array.isArray(node.props.children) && node.props.children[0] === '투표 ');
      assert.equal(total.props.children[1], 1); assert.ok(!JSON.stringify(resultsTree).includes('참여한 민수'));
    } finally { results.close(); }
  } finally { restore(); }
});

test('result lists keep tied ranks and scores without a repeated tie explanation', () => {
  const restore = environment();
  try {
    for (const method of ['winner', 'full']) {
      const rows = [1, 1, 3].map((rank, i) => ({ id: 'wine-' + i, candidateId: 'wine-' + i, number: i + 1, name: '와인 ' + i, photoUrl: null, rank, ...(method === 'winner' ? { votes: i < 2 ? 1 : 0 } : { points: i < 2 ? 4 : 1 }) }));
      const state = { activities: [{ id: 'byob', title: '질문', revision: 1, started: true, status: 'closed', votingMethod: method }], candidates: rows, byobResults: rows, submittedCount: 2 };
      const app = mount(() => uploadApi.RankedResponses({ state, action: async () => true, busy: false }));
      try {
        const tree = app.render(); assert.ok(!JSON.stringify(tree).includes('같으면 공동 순위'));
        const list = named(tree, 'RankedResultList'); const result = list.type(list.props);
        assert.equal(result.props.role, 'list'); assert.equal(result.props['aria-label'], method === 'winner' ? '와인별 순위와 득표수' : '와인별 순위와 총점');
        assert.deepEqual(nodes(result).filter(node => node.props?.className === 'ranked-result-rank').map(node => node.props.children), ['공동 1위', '공동 1위', '3위']);
        assert.deepEqual(nodes(result).filter(node => node.props?.className === 'ranked-result-points').map(node => node.props.children), method === 'winner' ? ['1표', '1표', '0표'] : ['4점', '4점', '1점']);
      } finally { app.close(); }
    }
  } finally { restore(); }
});

test('removed participation settings never survive drafts or patch validation', () => {
  const state = { event: { title: '기존 제목', participationMode: 'restricted' }, activities: [] };
  const server = progressServerFields(state); assert.equal(server['event:participationMode'], undefined);
  const stale = { 'event:participationMode': 'restricted' };
  assert.deepEqual(progressDraftChanges(state, server, stale), {});
  assert.deepEqual(progressSettingsUpdate(state, server, stale), { patch: {}, changes: {} });
  const updated = progressSettingsUpdate(state, server, { ...stale, 'event:title': '새 제목' });
  assert.deepEqual(updated.patch, { event: { title: '새 제목' } }); assert.equal(updated.changes['event:participationMode'], undefined);
});

test('participant enters a name directly even with legacy restricted event metadata', async () => {
  const restore = environment(); const requests = []; let joined = false; let focuses = 0;
  globalThis.location.pathname = '/v/direct-poll';
  globalThis.window.requestAnimationFrame = fn => { fn(); return 1; };
  globalThis.document.getElementById = () => ({ focus() { focuses++; } });
  globalThis.fetch = async (url, init) => {
    requests.push([url, init]);
    if (init.method === 'POST') { joined = true; return Response.json({ ok: true }); }
    return Response.json({ event: { title: '이름으로 참여', participationMode: 'restricted' }, activities: [], participant: joined ? { id: 'joined', name: '새 참여자', submitted: { byob: false } } : null, admin: false });
  };
  const shell = mount(uploadApi.App); const participantElement = shell.render(); const app = mount(() => participantElement.type(participantElement.props));
  try {
    app.render(); await settle(); let tree = app.render(); const text = JSON.stringify(tree);
    assert.ok(text.includes('참여할 이름')); assert.ok(!text.includes('등록된 이름')); assert.ok(!text.includes('명단'));
    nodes(tree).find(node => node.type === 'input').props.onChange({ target: { value: '새 참여자' } }); tree = app.render();
    await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault }); tree = app.render();
    assert.deepEqual(requests.filter(([, init]) => init.method === 'POST').map(([url, init]) => [url, JSON.parse(init.body)]), [['/v/direct-poll/api/session', { name: '새 참여자' }]]);
    assert.equal(nodes(tree).find(node => node.type === 'input'), undefined); assert.ok(JSON.stringify(tree).includes('새 참여자')); assert.equal(focuses, 1);
  } finally { await settle(); app.close(); shell.close(); restore(); }
});
