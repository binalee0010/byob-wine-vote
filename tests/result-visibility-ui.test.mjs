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
    control = mount(() => { const settings = named(app.render(), 'ActivitySettings'); return settings.type(settings.props); });
    const select = nodes(control.render()).find(node => node.type === 'select');
    assert.deepEqual(nodes(select).filter(node => node.type === 'option').map(node => [node.props.value, node.props.children]), [['private', '호스트만 보기'], ['participants', '참가자만 보기'], ['public', '전체 공개']]);
    for (const status of ['waiting', 'open', 'closed']) for (const scope of ['private', 'participants', 'public']) {
      const next = { ...state, activities: [activity('private', status)] }; const server = progressServerFields(next);
      const update = progressSettingsUpdate(next, server, { 'byob:2:resultVisibility': scope });
      assert.equal(update.patch.activities?.[0]?.resultVisibility ?? 'private', scope);
    }
  } finally { await settle(); control?.close(); app.close(); env.restore(); }
});

test('full ranking explains current candidate points outside the select only while selected', async () => {
  const env = environment(); let state = { event: { title: '모임' }, activities: [{ ...activity('private', 'waiting'), started: false, votingMethod: 'full' }], participants: [], submittedCount: 0, candidates: [] };
  const app = mount(() => Progress({ state, action: async () => true, busy: false })); let helpId;
  try {
    for (const [count, explanation] of [[0, '최하위 1점부터 순위마다 1점씩 증가'], [1, '1위 1점'], [7, '1위 7점, 최하위 1점']]) {
      state = { ...state, candidates: Array.from({ length: count }, (_, i) => ({ id: 'wine-' + i, number: i + 1, name: '와인 ' + i, photoUrl: null })) };
      const settings = named(app.render(), 'ActivitySettings'); const method = named(settings.type(settings.props), 'VotingMethodSetting');
      const methodTree = method.type(method.props); const select = nodes(methodTree).find(node => node.type === 'select');
      const option = nodes(select).find(node => node.type === 'option' && node.props.value === 'full');
      assert.equal([option.props.children].flat().join(''), '전체 순위 설정');
      helpId = select.props['aria-describedby']; assert.ok(helpId);
      const help = nodes(methodTree).find(node => node.props?.id === helpId);
      assert.equal(help.type, 'small'); assert.equal([help.props.children].flat().join(''), explanation);
      assert.ok(!nodes(select).includes(help)); assert.ok(nodes(methodTree).indexOf(select) < nodes(methodTree).indexOf(help));
      assert.equal(select.props.value, 'full');
    }
    for (const value of ['winner', 'custom']) {
      let settings = named(app.render(), 'ActivitySettings'); let method = named(settings.type(settings.props), 'VotingMethodSetting');
      nodes(method.type(method.props)).find(node => node.type === 'select').props.onChange({ target: { value } });
      settings = named(app.render(), 'ActivitySettings'); method = named(settings.type(settings.props), 'VotingMethodSetting');
      const methodTree = method.type(method.props); const select = nodes(methodTree).find(node => node.type === 'select');
      assert.equal(select.props.value, value); assert.ok(!select.props['aria-describedby']);
      assert.equal(nodes(methodTree).find(node => node.props?.id === helpId), undefined);
    }
  } finally { await settle(); app.close(); env.restore(); }
});

test('one nearby settings form preserves save retries and start-close guards with a long participant list', async () => {
  const env = environment(); const requests = []; let fail = true;
  let state = { event: { title: '모임', memo: '기존 메모' }, activities: [{ ...activity('private', 'waiting'), started: false, resultsLocked: false, votingMethod: 'full' }], participants: Array.from({ length: 200 }, (_, i) => ({ id: 'person-' + i, name: '참가자 ' + i })), submittedCount: 12, candidates: [], rosterRevision: 1 };
  const action = async (path, method, body, feedback) => {
    requests.push([path, method, JSON.parse(JSON.stringify(body))]);
    if (path === '/admin/settings') {
      if (fail) { feedback.error('설정 저장 실패'); return false; }
      state = { ...state, event: { ...state.event, ...body.event }, activities: state.activities.map(row => ({ ...row, ...body.activities?.find(update => update.id === row.id) })) };
    } else state = { ...state, activities: state.activities.map(row => ({ ...row, started: true, status: body.action === 'open' ? 'open' : 'closed' })) };
    return true;
  };
  const app = mount(() => Progress({ state, action, busy: false })); let controlNode; let control;
  const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.props.children === label);
  const form = tree => nodes(tree).find(node => node.type === 'form' && node.props.id === 'progress-settings');
  const settings = tree => { const node = named(tree, 'ActivitySettings'); return node.type(node.props); };
  const change = (input, value) => input.props.onChange({ target: { value } });
  const render = () => { const tree = app.render(); controlNode = named(tree, 'ActivityControl'); return tree; };
  try {
    let tree = render(); const initialForm = form(tree);
    assert.equal(nodes(tree).filter(node => node.type === 'form').length, 1);
    assert.equal(nodes(initialForm).filter(node => node.type === 'button' && node.props.children === '설정 모두 저장').length, 1);
    assert.ok(named(initialForm, 'ActivitySettings')); assert.equal(named(initialForm, 'Participants'), undefined); assert.equal(named(initialForm, 'ActivityControl'), undefined);
    assert.ok(nodes(tree).indexOf(initialForm) < nodes(tree).indexOf(named(tree, 'Participants')));
    assert.equal(controlNode.props.count, 12); assert.equal(controlNode.props.total, 200);
    assert.equal(button(initialForm, '설정 모두 저장').props.disabled, true);
    const eventInputs = nodes(initialForm).filter(node => node.type === 'input' || node.type === 'textarea');
    assert.deepEqual(eventInputs.map(node => node.props.value), ['모임', '기존 메모']);
    change(eventInputs[0], '새 모임'); change(eventInputs[1], '첫 줄\n둘째 줄');
    let activitySettings = settings(tree);
    change(nodes(activitySettings).find(node => node.type === 'input'), '새 질문');
    const method = named(activitySettings, 'VotingMethodSetting');
    change(nodes(method.type(method.props)).find(node => node.type === 'select'), 'winner');
    change(nodes(activitySettings).find(node => node.type === 'select'), 'participants');
    tree = render(); control = mount(() => controlNode.type(controlNode.props));
    assert.equal(button(control.render(), '시작').props.disabled, true);
    assert.ok([...nodes(form(tree)), ...nodes(settings(tree))].filter(node => ['input', 'textarea', 'select'].includes(node.type)).every(node => node.props.form === 'progress-settings'));
    await form(tree).props.onSubmit({ preventDefault() {} }); tree = render();
    assert.ok(JSON.stringify(form(tree)).includes('설정 저장 실패'));
    assert.deepEqual(nodes(form(tree)).filter(node => node.type === 'input' || node.type === 'textarea').map(node => node.props.value), ['새 모임', '첫 줄\n둘째 줄']);
    fail = false; await form(tree).props.onSubmit({ preventDefault() {} }); tree = render();
    assert.deepEqual(requests[0], ['/admin/settings', 'PATCH', { event: { title: '새 모임', memo: '첫 줄\n둘째 줄' }, activities: [{ id: 'byob', revision: 2, title: '새 질문', votingMethod: 'winner', resultVisibility: 'participants' }] }]);
    assert.deepEqual(requests[1], requests[0]); assert.equal(button(form(tree), '설정 모두 저장').props.disabled, true);
    let controls = control.render(); assert.equal(button(controls, '시작').props.disabled, false);
    assert.equal(nodes(controls).some(node => ['input', 'textarea', 'select'].includes(node.type)), false);
    button(controls, '시작').props.onClick(); await button(control.render(), '확인').props.onClick(); tree = render();
    assert.deepEqual(requests[2], ['/admin/activities/byob/state', 'POST', { action: 'open', revision: 2 }]);
    activitySettings = settings(tree); change(nodes(activitySettings).find(node => node.type === 'select'), 'public'); tree = render();
    assert.equal(button(control.render(), '마감').props.disabled, true);
    await form(tree).props.onSubmit({ preventDefault() {} }); tree = render(); controls = control.render();
    assert.equal(button(controls, '마감').props.disabled, false); button(controls, '마감').props.onClick();
    await button(control.render(), '확인').props.onClick();
    assert.deepEqual(requests.at(-1), ['/admin/activities/byob/state', 'POST', { action: 'close', revision: 2 }]);
  } finally { await settle(); control?.close(); app.close(); env.restore(); }
});

test('cancelling start or close restores its trigger focus or the progress heading when disabled', async () => {
  const env = environment(); let focused; let control;
  const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.props.children === label);
  globalThis.document.getElementById = id => { assert.equal(id, 'activity-progress-heading'); return { focus() { focused = 'heading'; } }; };
  try {
    for (const [status, label] of [['waiting', '시작'], ['open', '마감']]) for (const disabled of [false, true]) {
      const state = { event: { title: '모임' }, activities: [{ ...activity('private', status), started: status === 'open', resultsLocked: false }], participants: [], submittedCount: 0, candidates: [] };
      const app = mount(() => Progress({ state, action: async () => assert.fail('cancel must not send a request'), busy: false }));
      try {
        const node = named(app.render(), 'ActivityControl'); control = mount(() => node.type(node.props));
        const trigger = button(control.render(), label); focused = undefined;
        const target = { isConnected: true, disabled: false, focus() { focused = label; } }; trigger.props.ref.current = target;
        trigger.props.onClick(); let tree = control.render(); assert.ok(button(tree, '취소'));
        target.disabled = disabled; button(tree, '취소').props.onClick(); tree = control.render();
        assert.equal(button(tree, '취소'), undefined); assert.equal(focused, disabled ? 'heading' : label);
      } finally { control?.close(); control = undefined; app.close(); }
    }
  } finally { await settle(); control?.close(); env.restore(); }
});

test('custom rank selects replace an unselected wine, swap selected wines and save the visible order', async () => {
  const env = environment(); const requests = []; let fail = true; let refreshed = 0; let ballotNode; let ballot;
  const currentActivity = { ...activity('private', 'open'), resultsLocked: false, votingMethod: 'custom', rankPoints: [5, 2] };
  const candidates = ['a', 'b', 'c'].map((id, i) => ({ id, number: i + 1, name: id, photoUrl: null }));
  globalThis.fetch = async (path, init) => {
    if (init.method === 'GET') return Response.json({ activity: currentActivity, candidates, selectionCount: 2, mine: null });
    requests.push([path, init.method, JSON.parse(init.body)]);
    return fail ? Response.json({ error: '저장 실패' }, { status: 503 }) : Response.json({ ok: true });
  };
  const entry = mount(() => RankedVote({ activity: currentActivity, participant, refresh: async () => { refreshed++; return { activities: [currentActivity], participant: { ...participant, submitted: { byob: true } } }; }, onRevisionChanged() { assert.fail('the current vote remains active'); } }));
  const screen = entry.render(); const answer = mount(() => screen.type(screen.props));
  const render = () => { const tree = answer.render(); ballotNode = named(tree, 'CustomRankBallot'); return tree; };
  const select = id => nodes(ballot.render()).find(node => node.type === 'select' && node.props['aria-label'] === id + ' 순위');
  const choose = (id, place) => { select(id).props.onChange({ target: { value: place === null ? '' : String(place) } }); render(); };
  const readback = () => candidates.map(candidate => select(candidate.id).props.value);
  try {
    answer.render(); await settle(); let tree = render(); ballot = mount(() => ballotNode.type(ballotNode.props));
    for (const candidate of candidates) assert.deepEqual(nodes(select(candidate.id)).filter(node => node.type === 'option').map(node => node.props.value), ['', 0, 1]);
    choose('a', 0); choose('b', 0); assert.deepEqual(readback(), ['', 0, '']);
    choose('a', 1); choose('b', 1); assert.deepEqual(readback(), [0, 1, '']);
    choose('b', null); choose('a', 1); assert.deepEqual(readback(), [1, '', '']);
    tree = render(); assert.equal(nodes(tree).find(node => node.type === 'button' && node.props.children === '순위 제출').props.disabled, true);
    choose('a', 0); choose('b', 1); choose('c', 0); choose('b', 0); assert.deepEqual(readback(), ['', 0, 1]);
    const summary = named(ballot.render(), 'RankedBallot'); assert.equal(summary.props.compact, true); assert.deepEqual(summary.props.rankPoints, [5, 2]);
    summary.props.onDragMove('c', 0); render(); assert.deepEqual(readback(), ['', 1, 0]);
    named(ballot.render(), 'RankedBallot').props.onMove('c', 1); render(); assert.deepEqual(readback(), ['', 0, 1]);
    tree = render(); const submit = () => nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await submit(); tree = render(); assert.ok(JSON.stringify(tree).includes('저장 실패')); assert.deepEqual(readback(), ['', 0, 1]);
    fail = false; await submit(); tree = render();
    assert.deepEqual(requests, Array(2).fill(['/v/poll/api/activities/byob/answer', 'PUT', { ranking: ['b', 'c'], revision: 2, expectedParticipantId: participant.id }]));
    assert.equal(refreshed, 1); assert.ok(JSON.stringify(tree).includes('투표를 저장했어요.')); assert.deepEqual(readback(), ['', 0, 1]);
  } finally { ballot?.close(); answer.close(); entry.close(); env.restore(); }
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
    assert.ok(!JSON.stringify(tree).includes('같으면 공동 순위')); assert.ok(!JSON.stringify(tree).includes('함께 나누는 결과'));
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
