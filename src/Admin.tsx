import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type InputHTMLAttributes, type MouseEvent } from 'react';
import QRCode from 'qrcode';
import { api, apiPath, ApiError, getMemberCsrfToken, statusText, type Activity, type AdminActivity, type AdminState, type Candidate, type Member } from './api';
import { Notice, PhotoDialog, RankedResultList, Status } from './App';
import CandidatePhoto from './CandidatePhoto';
import { preparePhoto } from './image';
import { submissionStatusText, votingMethodInfo } from './format';
import { candidateNameChanges, customRankCount, keepProgressEdits, maxRankCount, progressDraftChanges, passwordChangeError, progressFieldKey, progressServerFields, progressSettingsUpdate, useServerDraft } from './forms';
import DestructiveAction, { type Action } from './DestructiveAction';
import { AdminHeader } from './SiteChrome';
const voteTabs = ['투표 진행', '후보 등록', '투표 결과'];
type ChangePassword = (currentPassword: string, newPassword: string) => Promise<void>;
type SettingField = (key: string, fallback?: string) => {
    form: string;
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
};
function ServerTextInput({ serverValue, ...props }: {
    serverValue: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange'>) {
    const [value, setValue] = useServerDraft(serverValue);
    return <input {...props} value={value} onChange={e => setValue(e.target.value)}/>;
}
export default function Admin({ member, pollSlug, onSettings, onLogout, loggingOut, sessionError, onSessionEnded }: { member?: Member; pollSlug?: string; onSettings?: () => void; onLogout?: () => void; loggingOut?: boolean; sessionError?: string; onSessionEnded?: () => void } = {}) {
    const [state, setState] = useState<AdminState | null>(null);
    const eventTitle = state?.event.title;
    useEffect(() => { document.title = eventTitle ? `${eventTitle} · 투표 관리` : '투표 관리'; }, [eventTitle]);
    const [tab, setTab] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [uploadBusy, setUploadBusy] = useState(false);
    const [registrationDraftVersion, setRegistrationDraftVersion] = useState(0);
    const [legacyChecking, setLegacyChecking] = useState(true);
    const [password, setPassword] = useState('');
    const loginInput = useRef<HTMLInputElement>(null);
    const passwordChanging = useRef(false);
    const epoch = useRef(0);
    const actionPending = useRef(false);
    const deletingPoll = useRef(false);
    const refresh = useCallback(async () => {
        if (passwordChanging.current || deletingPoll.current) return;
        const current = ++epoch.current;
        try {
            const data = await api<AdminState>('/admin/state');
            if (typeof data.event?.title !== 'string' || !Array.isArray(data.activities))
                throw new Error('관리 정보를 불러오지 못했습니다. 다시 시도해 주세요.');
            if (current === epoch.current) {
                setState(data);
                setLegacyChecking(false);
                setConnectionError('');
            }
        }
        catch (e) {
            if (current !== epoch.current)
                return;
            if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
                setState(null);
                setLegacyChecking(false);
                onSessionEnded?.();
                setConnectionError('');
            }
            else {
                if (e instanceof ApiError && (e.status === 404 || e.status === 410)) setState(null);
                setConnectionError((e as Error).message);
            }
        }
    }, [onSessionEnded]);
    useEffect(() => { if (!member && !legacyChecking && !state) loginInput.current?.focus(); }, [member, legacyChecking, state]);
    useEffect(() => { let stopped = false; let timer: number; const poll = async () => { await refresh(); if (!stopped)
        timer = window.setTimeout(poll, 3000); }; void poll(); return () => { stopped = true; ++epoch.current; clearTimeout(timer); }; }, [refresh]);
    const action: Action = async (path, method, body, feedback) => {
        if (actionPending.current || passwordChanging.current)
            return false;
        actionPending.current = true;
        setBusy(true);
        setError('');
        setMessage('');
        try {
            ++epoch.current;
            const result = await api(path, method, body);
            await refresh();
            const success = feedback?.success;
            setMessage(typeof success === 'function' ? success(result) : success || '저장했습니다.');
            return true;
        }
        catch (e) {
            const message = (e as Error).message;
            if (e instanceof ApiError && e.status === 401) {
                ++epoch.current;
                setState(null);
                onSessionEnded?.();
                setError('');
                setMessage('');
            }
            else if (feedback?.error)
                feedback.error(message);
            else
                setError(message);
            return false;
        }
        finally {
            actionPending.current = false;
            setBusy(false);
        }
    };
    const removePoll: Action = async (_path, _method, body, feedback) => {
        if (!member || !pollSlug || actionPending.current || passwordChanging.current || uploadBusy || loggingOut)
            return false;
        actionPending.current = true;
        deletingPoll.current = true;
        ++epoch.current;
        setBusy(true); setError(''); setMessage('');
        try {
            const result = await api<{ ok: boolean; slug: string }>('/members/polls/' + encodeURIComponent(pollSlug), 'DELETE', body);
            if (result.ok !== true || result.slug !== pollSlug)
                throw new Error('삭제 결과를 확인하지 못했습니다. 다시 시도해 주세요.');
            location.replace('/admin');
            return true;
        } catch (failure) {
            feedback?.error?.((failure as Error).message);
            return false;
        } finally {
            actionPending.current = false;
            deletingPoll.current = false;
            setBusy(false);
        }
    };
    async function legacyLogin(event: FormEvent) {
        event.preventDefault();
        if (actionPending.current) return;
        actionPending.current = true; ++epoch.current; setBusy(true); setError(''); setMessage('');
        try { await api('/admin/login', 'POST', { password }); setPassword(''); await refresh(); }
        catch (e) { setError((e as Error).message); }
        finally { actionPending.current = false; setBusy(false); }
    }
    async function legacyLogout() {
        if (actionPending.current || passwordChanging.current) return;
        actionPending.current = true; ++epoch.current; setBusy(true); setError('');
        try { await api('/admin/session', 'DELETE'); ++epoch.current; setState(null); setPassword(''); setMessage('로그아웃했습니다.'); }
        catch (e) { setError((e as Error).message); }
        finally { actionPending.current = false; setBusy(false); }
    }
    const legacyChangePassword: ChangePassword = async (currentPassword, newPassword) => {
        if (passwordChanging.current || actionPending.current) return;
        passwordChanging.current = true; ++epoch.current; setBusy(true); setError('');
        try { await api('/admin/password', 'POST', { currentPassword, newPassword }); ++epoch.current; setState(null); setPassword(''); setMessage('비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.'); }
        finally { passwordChanging.current = false; setBusy(false); }
    };
    const participantUrl = state?.participantUrl ?? (member ? undefined : new URL('/', location.origin).href);
    return <div className="admin-shell"><AdminHeader title={eventTitle || '투표 관리'} participantUrl={participantUrl} pollListUrl={member ? '/admin' : undefined} onSettings={onSettings} onLogout={member ? onLogout : state ? () => { void legacyLogout(); } : undefined} busy={busy || uploadBusy || loggingOut}/><main><Notice error>{sessionError}</Notice><Notice error>{connectionError}</Notice><Notice error>{error}</Notice><Notice>{message}</Notice>{!state && !member && !legacyChecking
            ? <section className="panel login-panel"><h2>관리자 로그인</h2><form onSubmit={legacyLogin}><label>비밀번호<input ref={loginInput} type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)}/></label><button className="primary" disabled={busy || !password}>{busy ? '확인 중…' : '로그인'}</button></form></section>
            : !state
            ? connectionError ? <button type="button" onClick={() => { setConnectionError(''); void refresh(); }}>다시 불러오기</button> : <p role="status">내 투표를 불러오고 있습니다…</p>
            : <><nav className="admin-tabs" aria-label="관리 메뉴">{voteTabs.map((title, index) => <button key={title} aria-current={tab === index ? 'page' : undefined} className={tab === index ? 'active' : ''} onClick={() => { setTab(index); setMessage(''); setError(''); }}>{title}</button>)}</nav>
    <div hidden={tab !== 0}><Progress state={state} action={action} busy={busy || uploadBusy || !!loggingOut} changePassword={member ? undefined : legacyChangePassword} onResetAll={() => setRegistrationDraftVersion(value => value + 1)} pollSlug={member ? pollSlug : undefined} removePoll={member && pollSlug ? removePoll : undefined}/></div>
    <div hidden={tab !== 1}><Candidates key={registrationDraftVersion} state={state} action={action} busy={busy} refresh={refresh} onUploadBusy={setUploadBusy}/></div>
    <div hidden={tab !== 2}><RankedResponses key={state.activities[0].revision} state={state} action={action} busy={busy || uploadBusy}/></div>
  </>}</main></div>;
}
export function Progress({ state, action, busy, changePassword, onResetAll, pollSlug, removePoll }: {
    state: AdminState;
    action: Action;
    busy: boolean;
    changePassword?: ChangePassword;
    onResetAll?: () => void;
    pollSlug?: string;
    removePoll?: Action;
}) {
    const [edits, setEdits] = useState<Record<string, string>>({});
    const [saveError, setSaveError] = useState('');
    const [qr, setQr] = useState('');
    const [copied, setCopied] = useState('');
    const serverFields = useMemo(() => progressServerFields(state), [state]);
    useEffect(() => { setEdits(current => keepProgressEdits(current, serverFields)); }, [serverFields]);
    const changes = progressDraftChanges(state, serverFields, edits);
    const dirty = Object.keys(changes).length > 0;
    const field: SettingField = (key, fallback = '') => ({
        form: 'progress-settings',
        value: serverFields[key] === undefined ? fallback : edits[key] ?? serverFields[key],
        onChange: event => {
            const value = event.target.value;
            setSaveError('');
            setEdits(current => {
                const next = { ...current, [key]: value };
                return keepProgressEdits(next, serverFields);
            });
        },
    });
    async function saveSettings(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || !dirty)
            return;
        setSaveError('');
        try {
            const update = progressSettingsUpdate(state, serverFields, changes);
            if (!Object.keys(update.patch).length) {
                setEdits({});
                return;
            }
            if (await action('/admin/settings', 'PATCH', update.patch, { error: setSaveError, success: '설정을 저장했습니다.' })) {
                setEdits(update.changes);
            }
        }
        catch (error) {
            setSaveError((error as Error).message);
        }
    }
    const participantUrl = state.participantUrl ?? new URL('/', location.origin).href;
    useEffect(() => { QRCode.toDataURL(participantUrl, { width: 256, margin: 4, color: { dark: '#682339', light: '#ffffff' } }).then(setQr).catch(() => setCopied('QR 코드를 만들지 못했습니다. 주소를 복사해 주세요.')); }, [participantUrl]);
    async function copy() { try {
        await navigator.clipboard.writeText(participantUrl);
        setCopied('참가자 주소를 복사했습니다.');
    }
    catch {
        setCopied('주소를 길게 누르거나 선택해 복사해 주세요.');
    } }
    const responseCount = state.submittedCount;
    const expectedRevisions = Object.fromEntries(state.activities.map(activity => [activity.id, activity.revision]));
    const resetAll: Action = async (path, method, body, feedback) => {
        if (!await action(path, method, body, feedback))
            return false;
        setEdits({});
        setSaveError('');
        onResetAll?.();
        return true;
    };
    return <div className="admin-grid progress-layout">
    <div className="progress-controls">{state.activities.map(activity => <ActivityControl key={activity.id + ':' + activity.revision} activity={activity} count={state.submittedCount} total={state.participants.length} action={action} busy={busy} field={field} startBlocked={dirty}/>)}</div>
    <section className="panel share-panel">
      <div><h2>투표 링크</h2>
        <a className="share-url" href={participantUrl} target="_blank" rel="noreferrer">{participantUrl}</a>
        <button className="secondary" type="button" onClick={copy}>주소 복사</button><Notice>{copied}</Notice>
      </div>{qr && <img className="qr" src={qr} alt="참가자 입장 주소 QR 코드"/>}
    </section>
    <form id="progress-settings" className="panel progress-settings" onSubmit={saveSettings}>
      <h2>투표 정보</h2>
      <div className="progress-fields">
        <label>투표 제목<input {...field('event:title')} maxLength={120} required disabled={busy}/></label>
        <label>메모<textarea {...field('event:memo')} maxLength={2000} rows={4} disabled={busy}/></label>
        {state.activities.map(activity => <ActivitySettings key={activity.id + ':' + activity.revision} activity={activity} busy={busy} field={field} candidateCount={state.candidates.length}/>)}
      </div>
      <Notice error>{saveError}</Notice>
      <button className="primary" disabled={busy || !dirty}>설정 모두 저장</button>
    </form>
    <Participants state={state}/>
    {changePassword && <PasswordChange busy={busy} onChangePassword={changePassword}/>}
    <div className="full-width progress-danger-zone">
    <section className="panel destructive-panel">
      <h2>투표 기록 초기화</h2>
      <p className="muted">제출·미제출 참가 기록과 응답·결과를 지우고 투표를 대기로 되돌립니다. 와인과 사진, 투표 정보와 참가 링크는 유지됩니다.</p>
      {state.activities.map(activity => <DestructiveAction key={activity.id} label="투표 기록 초기화" accessibleLabel={activity.title + ' 투표 기록 초기화'} action={action} busy={busy} focusFallback="activity-progress-heading" request={{
        title: '‘' + activity.title + '’ 투표 기록을 초기화할까요?',
        description: `제출·미제출 참가자 ${state.participants.length}명의 입장 기록과 참가 세션, 투표 ${responseCount}건과 현재 결과를 삭제합니다. 대기 상태로 돌아가며 결과 공개는 ‘호스트만 보기’로 바뀌고 잠금이 풀립니다. 와인과 사진, 투표 정보와 참가 링크는 유지됩니다. 참가자는 같은 링크에서 이름을 다시 입력해 입장할 수 있습니다. 이 작업은 되돌릴 수 없습니다.`,
        path: '/admin/activities/' + activity.id + '/reset', method: 'POST',
        body: { confirm: 'reset', expectedRevision: activity.revision }, success: '투표 기록을 초기화했습니다. 참가자는 같은 링크에서 이름을 다시 입력해 입장할 수 있습니다.',
      }}/>)}
    </section>
    {<section className="panel destructive-panel">
      <h2>투표 전체 초기화</h2>
      <p className="muted">제출·미제출 참가 기록과 와인·사진, 응답·결과를 모두 지우고 투표를 대기로 되돌립니다. 투표 정보와 참가 링크는 유지됩니다.</p>
      <DestructiveAction label="투표 전체 초기화" action={resetAll} busy={busy} request={{
                title: '현재 투표를 전체 초기화할까요?',
                description: `이 투표의 제출·미제출 참가 기록과 참가 세션, 와인 ${state.candidates?.length ?? 0}개와 사진, 투표 ${responseCount}건과 현재 결과를 삭제합니다. 투표 제목·메모·방식·배점과 참가 링크, 호스트 로그인은 유지됩니다. 결과 공개는 ‘호스트만 보기’로 바뀝니다. 참가자는 같은 링크에서 이름을 다시 입력해 입장할 수 있습니다. 이 작업은 되돌릴 수 없습니다.`,
                path: '/admin/reset-all', method: 'POST', body: { confirm: 'reset-all', expectedRevision: expectedRevisions.byob, expectedRosterRevision: state.rosterRevision },
                phrase: '투표 전체 초기화', success: result => photoCleanupPending(result)
                    ? '투표 전체를 초기화했습니다. 후보 등록 화면에서 남은 사진을 정리할 수 있습니다.'
                    : '투표 전체를 초기화했습니다.',
            }}/>
    </section>}
    {pollSlug && removePoll && <section className="panel destructive-panel">
      <h2>투표 삭제</h2>
      <p className="muted">삭제하면 이 투표의 참가 링크가 닫히고 응답과 결과를 다시 볼 수 없습니다.</p>
      <DestructiveAction label="투표 삭제" accessibleLabel={state.event.title + ' 투표 삭제'} action={removePoll} busy={busy} request={{
        title: '‘' + state.event.title + '’ 투표를 삭제할까요?',
        description: '삭제하면 이 투표의 참가 링크가 닫히고 응답과 결과를 다시 볼 수 없습니다.',
        path: '/members/polls/' + encodeURIComponent(pollSlug), method: 'DELETE', body: { confirm: 'delete-poll' }, success: '투표를 삭제했습니다.',
      }}/>
    </section>}</div></div>;
}
export function PasswordChange({ busy, onChangePassword }: {
    busy: boolean;
    onChangePassword: ChangePassword;
}) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const submitting = useRef(false);
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (submitting.current || busy)
            return;
        const validation = passwordChangeError(current, next, confirmation);
        setError(validation);
        if (validation)
            return;
        submitting.current = true;
        setPending(true);
        try {
            await onChangePassword(current, next);
            setCurrent('');
            setNext('');
            setConfirmation('');
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            submitting.current = false;
            setPending(false);
        }
    }
    return <details className="panel full-width password-settings"><summary>비밀번호 변경</summary><p className="muted">변경하면 내 계정의 모든 세션이 종료됩니다. 새 비밀번호로 다시 로그인해 주세요.</p><form onSubmit={submit}><fieldset className="password-fields" disabled={busy || pending}><label>현재 비밀번호<input name="currentPassword" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)}/></label><label>새 비밀번호<input name="newPassword" type="password" autoComplete="new-password" required value={next} onChange={e => setNext(e.target.value)}/></label><label>새 비밀번호 확인<input name="confirmPassword" type="password" autoComplete="new-password" required value={confirmation} onChange={e => setConfirmation(e.target.value)}/></label><button className="primary">{pending ? '변경 중…' : '비밀번호 변경'}</button></fieldset><Notice error>{error}</Notice></form></details>;
}
export function VotingMethodSetting({ activity, busy, field, candidateCount }: {
    activity: Activity;
    busy: boolean;
    field: SettingField;
    candidateCount: number;
}) {
    const method = field(progressFieldKey(activity, 'votingMethod'), activity.votingMethod ?? 'full');
    const count = field(progressFieldKey(activity, 'rankCount'), String(activity.rankPoints?.length ?? 2));
    const fullPointsHelp = activity.id + '-full-rank-points';
    return <>
    <label>투표 방식<select className="activity-reveal-select" {...method} disabled={activity.started || busy} aria-describedby={method.value === 'full' ? fullPointsHelp : undefined}>
      <option value="winner">{votingMethodInfo.winner.label} · 1표</option>
      <option value="full">{votingMethodInfo.full.label}</option>
      <option value="custom">{votingMethodInfo.custom.label}</option>
    </select></label>
    {method.value === 'full' && <small id={fullPointsHelp}>{candidateCount > 1 ? `1위 ${candidateCount}점, 최하위 1점` : candidateCount === 1 ? '1위 1점' : '최하위 1점부터 순위마다 1점씩 증가'}</small>}
    {method.value === 'custom' && <>
      <label>선택 개수 <small>1~{maxRankCount}개</small><input {...count} inputMode="numeric" maxLength={3} disabled={activity.started || busy}/></label>
      <div className="rank-point-fields">{Array.from({ length: customRankCount(count.value) }, (_, place) => <label key={place}>{place + 1}위 배점
        <input {...field(progressFieldKey(activity, `rankPoint:${place}`), activity.rankPoints?.[place]?.toString())} inputMode="numeric" maxLength={7} disabled={activity.started || busy}/>
      </label>)}</div>
      <small>배점은 0~1,000,000점 사이의 정수로, 한 순위 이상은 1점 이상이어야 합니다.</small>
    </>}
    {activity.started && <small>투표 기록 초기화 후 방식을 바꿀 수 있습니다.</small>}
  </>;
}
export function ActivitySettings({ activity, busy, field, candidateCount }: { activity: AdminActivity; busy: boolean; field: SettingField; candidateCount: number }) {
    const visibility = field(progressFieldKey(activity, 'resultVisibility'));
    const visibilityHelp = activity.id + '-result-visibility-help';
    const visibilityChanged = visibility.value !== activity.resultVisibility;
    const resultsLocked = activity.resultsLocked || activity.published;
    return <><div className="progress-fields">
      <label>투표 질문<input {...field(progressFieldKey(activity, 'title'))} maxLength={120} required disabled={busy}/></label>
      <VotingMethodSetting activity={activity} busy={busy} field={field} candidateCount={candidateCount}/>
      {<div>
        <label>결과 공개<select className="activity-reveal-select" {...visibility} disabled={busy} aria-describedby={visibilityHelp}>
          <option value="private">호스트만 보기</option>
          <option value="participants">참가자만 보기</option>
          <option value="public">전체 공개</option>
        </select></label>
        <small id={visibilityHelp}>
          {visibility.value === 'participants'
                ? activity.status === 'closed'
                    ? visibilityChanged ? '저장하면 이 투표에 참여했던 이름으로 로그인한 참가자만 결과를 볼 수 있습니다.' : '이 투표에 참여했던 이름으로 로그인한 참가자만 결과를 볼 수 있습니다.'
                    : '마감 후 이 투표에 참여했던 이름으로 로그인한 참가자만 결과를 볼 수 있습니다.'
                : visibility.value === 'public'
                    ? activity.status === 'closed'
                        ? visibilityChanged ? '저장하면 링크가 있는 누구나 결과를 볼 수 있습니다.' : '링크가 있는 누구나 결과를 볼 수 있습니다.'
                        : '마감 후 링크가 있는 누구나 결과를 볼 수 있습니다.'
                    : activity.status === 'closed' && visibilityChanged ? '저장하면 호스트만 결과를 볼 수 있습니다.' : ''}
          {activity.status === 'open' && visibilityChanged && ' 결과 공개 설정을 저장한 뒤 마감할 수 있습니다.'}
          {resultsLocked ? ' 결과가 잠긴 투표는 다시 시작할 수 없습니다.' : visibility.value !== 'private' && ' 결과를 공개한 뒤에는 다시 시작할 수 없습니다.'}
        </small>
      </div>}
    </div></>;
}
function ActivityControl({ activity, count, total, action, busy, field, startBlocked }: {
    activity: AdminActivity;
    count: number;
    total: number;
    action: Action;
    busy: boolean;
    field: SettingField;
    startBlocked: boolean;
}) {
    const [confirm, setConfirm] = useState<'open' | 'close' | null>(null);
    const startButton = useRef<HTMLButtonElement>(null);
    const closeButton = useRef<HTMLButtonElement>(null);
    function cancelConfirmation() {
        const trigger = confirm === 'open' ? startButton.current : closeButton.current;
        setConfirm(null);
        if (trigger?.isConnected && !trigger.disabled) trigger.focus();
        else document.getElementById('activity-progress-heading')?.focus();
    }
    const visibility = field(progressFieldKey(activity, 'resultVisibility'));
    const visibilityChanged = visibility.value !== activity.resultVisibility;
    const willPublishOnClose = activity.resultVisibility !== 'private';
    const resultsLocked = activity.resultsLocked || activity.published;
    const startDisabled = busy || startBlocked || resultsLocked || activity.status === 'open';
    const closeDisabled = busy || activity.status !== 'open' || visibilityChanged;
    const confirmDisabled = confirm === 'open' ? startDisabled : closeDisabled;
    return <article className="panel activity-control">
    <div className="row spread"><h2 id="activity-progress-heading" tabIndex={-1}>진행 상태</h2><Status activity={activity}/></div>
    {startBlocked && <p className="muted">설정을 모두 저장한 뒤 시작할 수 있습니다.</p>}
    <a className="count" href="#submission-status-heading" aria-label={`제출 현황 보기: ${total}명 중 ${count}명 제출`}><strong>{count}</strong> / {total}<span>명 제출</span></a>
    <div className="control-actions">
      <button ref={startButton} type="button" className={activity.status !== 'open' && !resultsLocked ? 'primary' : undefined} disabled={startDisabled} onClick={() => setConfirm('open')}>{activity.started ? '다시 시작' : '시작'}</button>
      <button ref={closeButton} type="button" className={activity.status === 'open' ? 'primary' : undefined} disabled={closeDisabled} onClick={() => setConfirm('close')}>마감</button>
    </div>
    {confirm && <div className="confirm-box">
      <p>{confirm === 'close' ? <>
        지금 참여를 마감할까요?
        {willPublishOnClose && (activity.resultVisibility === 'participants' ? ' 마감하면 참여했던 이름으로 로그인한 참가자만 결과를 볼 수 있습니다. 공개 후에는 다시 시작할 수 없습니다.' : ' 마감하면 링크가 있는 누구나 결과를 볼 수 있습니다. 공개 후에는 다시 시작할 수 없습니다.')}
      </> : `${votingMethodInfo[activity.votingMethod ?? 'full'].label} 방식으로 투표를 열까요? 시작하면 투표 방식과 후보 목록이 확정됩니다.`}</p>
      <div className="row">
        <button type="button" className="primary" disabled={confirmDisabled} onClick={async () => {
                if (confirmDisabled)
                    return;
                if (await action('/admin/activities/' + activity.id + '/state', 'POST', { action: confirm, revision: activity.revision }))
                    setConfirm(null);
            }}>확인</button>
        <button type="button" disabled={busy} onClick={cancelConfirmation}>취소</button>
      </div>
    </div>}
  </article>;
}
export function Participants({ state }: { state: AdminState }) {
    return <section className="panel">
      <h2 id="submission-status-heading" tabIndex={-1}>제출 현황</h2>
      {!state.participants.length ? <p className="muted">아직 참여한 사람이 없습니다.</p>
        : <ul className="submission-status-list" aria-label="참여자별 제출 현황">{state.participants.map(participant => <li key={participant.id}>
          <strong>{participant.name}</strong><span className={participant.submitted?.byob ? 'submitted-text' : 'muted'}>{submissionStatusText(!!participant.submitted?.byob)}</span>
        </li>)}</ul>}
    </section>;
}
const maxWineNameLength = 160;
type Upload = {
    id: string;
    revision: number;
    file?: File;
    fileName?: string;
    name: string;
    state: 'ready' | 'compressing' | 'uploading' | 'done' | 'error';
    progress: number;
    error?: string;
    prepared?: File;
};
export function sendPhoto(upload: Upload, file: File, onProgress: (value: number) => void, replacement?: { candidateId: string; expectedPhotoUrl: string }): Promise<Candidate> { return new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open(replacement ? 'PUT' : 'POST', apiPath('/admin/candidates' + (replacement ? '/' + encodeURIComponent(replacement.candidateId) + '/photo' : ''))); const csrf = getMemberCsrfToken(); if (csrf) xhr.setRequestHeader('X-Member-CSRF', csrf); xhr.responseType = 'json'; xhr.timeout = 45000; xhr.upload.onprogress = e => { if (e.lengthComputable)
    onProgress(Math.round(e.loaded / e.total * 100)); }; xhr.onload = () => { const data = xhr.response as {
    candidate?: Candidate;
    ok?: boolean;
    error?: string;
} | null; if (xhr.status >= 200 && xhr.status < 300 && data?.candidate?.id && (!replacement || (data.ok === true && data.candidate.id === replacement.candidateId && typeof data.candidate.photoUrl === 'string')))
    resolve(data.candidate);
else
    reject(new Error(data?.error || '업로드하지 못했습니다. 다시 시도해 주세요.')); }; xhr.onerror = xhr.ontimeout = () => reject(new Error('연결이 끊겼습니다. 다시 시도하면 같은 사진이 중복 등록되지 않습니다.')); const form = new FormData(); form.set('file', file); if (replacement) form.set('expectedPhotoUrl', replacement.expectedPhotoUrl); else if (upload.name) form.set('name', upload.name); form.set('requestId', upload.id); form.set('revision', String(upload.revision)); xhr.send(form); }); }
export function CandidatePhotoEditor({ candidate, revision, busy, onStart, onFinish, refresh, onPhoto }: {
    candidate: Candidate; revision: number; busy: boolean; onStart: () => boolean; onFinish: () => void;
    refresh: () => Promise<void>; onPhoto: (candidate: Candidate) => void;
}) {
    const [upload, setUpload] = useState<(Upload & { expectedPhotoUrl: string }) | null>(null);
    const [saved, setSaved] = useState<{ previousPhotoUrl: string | null; photoUrl: string } | null>(null);
    const submitting = useRef(false);
    const display = saved && candidate.photoUrl === saved.previousPhotoUrl ? { ...candidate, photoUrl: saved.photoUrl } : candidate;
    async function submit(next: NonNullable<typeof upload>) {
        if (busy || submitting.current || !onStart()) return;
        submitting.current = true;
        setUpload({ ...next, state: 'compressing', error: '' });
        try {
            const file = next.prepared || await preparePhoto(next.file!);
            next = { ...next, prepared: file, state: 'uploading', progress: 0 };
            setUpload(next);
            const result = await sendPhoto(next, file, progress => setUpload(current => current && ({ ...current, progress })), { candidateId: candidate.id, expectedPhotoUrl: next.expectedPhotoUrl });
            setSaved({ previousPhotoUrl: candidate.photoUrl, photoUrl: result.photoUrl! });
            setUpload({ ...next, fileName: next.file?.name, file: undefined, prepared: undefined, state: 'done' });
            await refresh();
        } catch (failure) {
            setUpload({ ...next, state: 'error', error: (failure as Error).message });
        } finally {
            submitting.current = false;
            onFinish();
        }
    }
    return <><CandidatePhoto candidate={display} onPhoto={onPhoto}/><div className="candidate-photo-upload">
      <label>{display.photoUrl ? '사진 변경' : '사진 추가'}<input type="file" accept="image/jpeg,image/png,image/webp,.heic,.heif" aria-label={candidate.name + (display.photoUrl ? ' 사진 변경' : ' 사진 추가')} disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) void submit({ id: crypto.randomUUID(), name: candidate.name, revision, expectedPhotoUrl: display.photoUrl ?? '', file, state: 'ready', progress: 0 });
      }}/></label>
      {upload && <div className="upload-status" role="status">
        <small className="filename">{upload.fileName ?? upload.file?.name}</small>
        {upload.state === 'compressing' ? '사진 처리 중…' : upload.state === 'uploading' ? `업로드 ${upload.progress}%` : upload.state === 'done' ? '사진을 저장했습니다.' : null}
        {upload.state === 'uploading' && <progress max={100} value={upload.progress} aria-label={candidate.name + ' 사진 업로드 진행률'}/>}
        {upload.error && <p role="alert">{upload.error}</p>}
        {upload.state === 'error' && <button type="button" disabled={busy} onClick={() => { void submit(upload); }}>사진 다시 시도</button>}
      </div>}
    </div></>;
}
export async function submitCandidateUploads(uploads: Upload[], revision: number, update: (id: string, patch: Partial<Upload>) => void, refresh: () => Promise<void>) {
    for (const upload of uploads) {
        if (upload.revision !== revision || (upload.state !== 'ready' && upload.state !== 'error'))
            continue;
        try {
            let candidate: Candidate;
            if (upload.file) {
                update(upload.id, { state: 'compressing', error: '' });
                const file = upload.prepared || await preparePhoto(upload.file);
                update(upload.id, { state: 'uploading', prepared: file, progress: 0 });
                candidate = await sendPhoto(upload, file, progress => update(upload.id, { progress }));
            }
            else {
                update(upload.id, { state: 'uploading', error: '' });
                ({ candidate } = await api<{
                    candidate: Candidate;
                }>('/admin/candidates', 'POST', { name: upload.name, requestId: upload.id, revision: upload.revision }));
                if (!candidate?.id)
                    throw new Error('등록 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
            }
            update(upload.id, { state: 'done', progress: 100, name: candidate.name, fileName: upload.file?.name, file: undefined, prepared: undefined });
        }
        catch (e) {
            update(upload.id, { state: 'error', error: (e as Error).message });
            continue;
        }
        try { await refresh(); }
        catch (e) { update(upload.id, { error: (e as Error).message }); }
    }
}
function photoCleanupPending(result: unknown) {
    return result !== null && typeof result === 'object' && 'cleanupPending' in result && typeof result.cleanupPending === 'number' && result.cleanupPending > 0;
}
async function saveCandidateNames(event: FormEvent<HTMLFormElement>, state: AdminState, action: Action, setError: (value: string) => void, setFeedback: (value: string) => void) {
    event.preventDefault();
    setError('');
    setFeedback('');
    const names = candidateNameChanges(state.candidates, new FormData(event.currentTarget));
    if (!names.length) {
        setFeedback('변경된 와인 정보가 없습니다.');
        return false;
    }
    if (names.some(row => !row.name)) {
        setError('와인 이름을 비워 둘 수 없습니다.');
        return false;
    }
    return action('/admin/candidates/names', 'PUT', { names, revision: state.activities.find(row => row.id === 'byob')!.revision }, {
        error: setError, success: `와인 정보 ${names.length}개를 저장했습니다.`,
    });
}
export function Candidates({ state, action, busy, refresh, onUploadBusy }: {
    state: AdminState;
    action: Action;
    busy: boolean;
    refresh: () => Promise<void>;
    onUploadBusy: (busy: boolean) => void;
}) {
    const [uploads, setUploads] = useState<Upload[]>([]);
    const [uploading, setUploading] = useState(false);
    const [draggingPhotos, setDraggingPhotos] = useState(false);
    const [photo, setPhoto] = useState<Candidate | null>(null);
    const [deleting, setDeleting] = useState<{
        id: string;
        revision: number;
    } | null>(null);
    const [nameError, setNameError] = useState('');
    const [nameFeedback, setNameFeedback] = useState('');
    const [namesDraft, setNamesDraft] = useState<{
        text: string;
        revision: number;
    } | null>(null);
    const [registrationError, setRegistrationError] = useState('');
    const uploadPending = useRef(false);
    const byob = state.activities.find(a => a.id === 'byob')!;
    const locked = byob.started;
    const metadataLocked = locked && byob.status !== 'closed';
    const failedUploads = uploads.filter(row => row.revision === byob.revision && row.state === 'error');
    const staleNames = namesDraft !== null && namesDraft.revision !== byob.revision;
    function beginPhotoUpload() {
        if (busy || uploadPending.current) return false;
        uploadPending.current = true; setUploading(true); onUploadBusy(true);
        return true;
    }
    function finishPhotoUpload() {
        uploadPending.current = false; setUploading(false); onUploadBusy(false);
    }
    const resetWines: Action = async (path, method, body, feedback) => {
        if (locked || busy || uploadPending.current || !await action(path, method, body, feedback))
            return false;
        setUploads([]);
        setPhoto(null);
        setDeleting(null);
        setNameError('');
        setNameFeedback('');
        setNamesDraft(null);
        setRegistrationError('');
        return true;
    };
    async function retryPhotoCleanup(event: MouseEvent<HTMLButtonElement>) {
        const button = event.currentTarget;
        const focused = document.activeElement === button;
        await action('/admin/candidates/cleanup', 'POST', undefined, {
            success: result => photoCleanupPending(result) ? '아직 삭제되지 않은 사진이 있습니다. 다시 시도해 주세요.' : '남은 사진을 모두 삭제했습니다.',
        });
        if (focused)
            window.requestAnimationFrame(() => {
                if (document.activeElement === document.body)
                    (button.isConnected ? button : document.getElementById('registered-wines-heading'))?.focus();
            });
    }
    function update(id: string, patch: Partial<Upload>) { setUploads(old => old.map(row => row.id === id ? { ...row, ...patch } : row)); }
    async function uploadAll(rows: Upload[]) {
        if (locked || busy || uploadPending.current)
            return;
        uploadPending.current = true;
        setUploading(true);
        onUploadBusy(true);
        try {
            await submitCandidateUploads(rows, byob.revision, update, refresh);
        }
        finally {
            uploadPending.current = false;
            setUploading(false);
            onUploadBusy(false);
        }
    }
    function addPhotos(files: File[]) {
        if (!files.length || locked || busy || uploadPending.current)
            return;
        const rows: Upload[] = files.map(file => ({ id: crypto.randomUUID(), revision: byob.revision, file, name: '', state: 'ready', progress: 0 }));
        setUploads(current => [...current, ...rows]);
        void uploadAll(rows);
    }
    function selectPhotos(event: ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        addPhotos(files);
    }
    function dragPhotos(event: DragEvent<HTMLLabelElement>) {
        event.preventDefault();
        const allowed = event.dataTransfer.types.includes('Files') && !locked && !busy && !uploadPending.current;
        event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
        setDraggingPhotos(allowed);
    }
    function dropPhotos(event: DragEvent<HTMLLabelElement>) {
        event.preventDefault();
        event.stopPropagation();
        setDraggingPhotos(false);
        addPhotos(Array.from(event.dataTransfer.files));
    }
    function registerNames(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (locked || busy || uploadPending.current || !namesDraft || staleNames)
            return;
        const names = namesDraft.text.split(/\r?\n/u).map(name => name.normalize('NFKC').trim()).filter(Boolean);
        if (!names.length)
            return;
        if (names.some(name => name.length > maxWineNameLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(name))) {
            setRegistrationError(`와인 이름은 한 줄에 ${maxWineNameLength}자 이내로 입력해 주세요.`);
            return;
        }
        const rows: Upload[] = names.map(name => ({ id: crypto.randomUUID(), revision: namesDraft.revision, name, state: 'ready', progress: 0 }));
        setNamesDraft(null);
        setRegistrationError('');
        setUploads(current => [...current, ...rows]);
        void uploadAll(rows);
    }
    async function move(index: number, offset: number) { const ids = state.candidates.map(c => c.id); [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]]; await action('/admin/candidates/order', 'PUT', { ids, revision: byob.revision }); }
    async function saveNames(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (metadataLocked || busy || uploading)
            return;
        await saveCandidateNames(event, state, action, setNameError, setNameFeedback);
    }
    return <>{(!locked || metadataLocked || uploads.length > 0) && <section className="panel">{locked ? metadataLocked && <Notice>진행 중에는 사진만 변경할 수 있습니다.</Notice> : <><label className={'file-picker' + (draggingPhotos && !uploading && !busy ? ' is-dragging' : '')} onDragOverCapture={dragPhotos} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingPhotos(false); }} onDropCapture={dropPhotos}>와인 사진 등록<input type="file" accept="image/jpeg,image/png,image/webp,.heic,.heif" multiple aria-label="와인 사진 등록" aria-describedby="candidate-photo-drop-help" disabled={uploading || busy} onChange={selectPhotos}/><small id="candidate-photo-drop-help">사진을 여기에 끌어다 놓거나 파일을 선택하면 바로 등록됩니다.</small></label><small>JPEG·PNG·WebP · HEIC는 JPEG·PNG로 변환해 주세요.</small>
    <form className="wine-name-form" onSubmit={registerNames}>
      <label>사진 없이 등록
        <textarea value={namesDraft?.text ?? ''} disabled={uploading || busy || staleNames} rows={3} placeholder="와인 이름을 한 줄에 하나씩 입력" onChange={event => {
                setNamesDraft({ text: event.target.value, revision: byob.revision });
                setRegistrationError('');
            }}/>
      </label>
      <Notice error>{registrationError}</Notice>
      {staleNames
                ? <><Notice>투표가 초기화되어 이전에 입력한 이름은 등록할 수 없습니다.</Notice><button type="button" disabled={uploading || busy} onClick={() => { setNamesDraft(null); setRegistrationError(''); }}>이전 입력 지우기</button></>
                : <button type="submit" className="secondary" disabled={uploading || busy || !namesDraft?.text.trim()}>이름만 등록</button>}
    </form></>}{uploads.length > 0 && <div className="upload-list">{uploads.map(upload => <div className={'upload-row ' + upload.state} key={upload.id}><div><small className="filename">{upload.fileName ?? upload.file?.name ?? "사진 없이 등록"}</small>{upload.name && <span>{upload.name}</span>}</div><div className="upload-status"><strong>{upload.state === 'done' ? '✓ 등록 완료' : upload.state === 'compressing' ? '사진 처리 중…' : upload.state === 'uploading' ? (upload.file ? `업로드 ${upload.progress}%` : '등록 중…') : upload.state === 'error' ? '등록 실패' : '등록 대기'}</strong>{upload.state === 'uploading' && upload.file && <progress max={100} value={upload.progress} aria-label={upload.file.name + ' 업로드 진행률'}/>}{upload.revision !== byob.revision && upload.state !== 'done' ? <p>{upload.file ? "투표가 초기화되었습니다. 이 사진은 다시 선택해 주세요." : "투표가 초기화되었습니다. 이 이름은 다시 입력해 주세요."}</p> : upload.error && <p role="alert">{upload.error}</p>}{upload.state === 'error' && upload.revision === byob.revision && !locked && <button type="button" disabled={uploading || busy} aria-label={(upload.file?.name ?? upload.name) + ' 다시 시도'} onClick={() => void uploadAll([upload])}>다시 시도</button>}</div></div>)}</div>}{!locked && failedUploads.length > 1 && <button type="button" className="secondary" disabled={uploading || busy} onClick={() => void uploadAll(failedUploads)}>실패한 와인 다시 시도</button>}</section>}<div className="section-heading"><h2 id="registered-wines-heading" tabIndex={-1}>등록된 와인 {state.candidates.length}개</h2></div><form className="candidate-names-form" onSubmit={saveNames} onChange={() => { setNameError(''); setNameFeedback(''); }}><div className="candidate-grid admin-candidates">{state.candidates.map((candidate, index) => <section className="candidate-card" key={candidate.id + ":" + byob.revision}><CandidatePhotoEditor candidate={candidate} revision={byob.revision} busy={busy || uploading} onStart={beginPhotoUpload} onFinish={finishPhotoUpload} refresh={refresh} onPhoto={setPhoto}/><div className="candidate-editor"><p className="eyebrow">와인 {String(candidate.number).padStart(2, '0')}</p><label>표시 이름<ServerTextInput name={candidate.id} aria-label={'와인 ' + candidate.number + ' 표시 이름'} serverValue={candidate.name} required maxLength={maxWineNameLength} disabled={metadataLocked || uploading || busy}/></label>{!locked && <><div className="row"><button type="button" aria-label={candidate.name + ' 위로 이동'} disabled={busy || uploading || index === 0} onClick={() => move(index, -1)}>↑ 위로</button><button type="button" aria-label={candidate.name + ' 아래로 이동'} disabled={busy || uploading || index === state.candidates.length - 1} onClick={() => move(index, 1)}>↓ 아래로</button><button type="button" className="danger" disabled={busy || uploading} onClick={() => setDeleting({ id: candidate.id, revision: byob.revision })}>삭제</button></div>{deleting?.id === candidate.id && deleting.revision === byob.revision && <div className="confirm-box"><p>이 와인을 삭제할까요?</p><div className="row"><button type="button" className="danger" disabled={busy || uploading} onClick={async () => { if (await action('/admin/candidates/' + candidate.id, 'DELETE', { revision: deleting.revision }))
        setDeleting(null); }}>삭제 확인</button><button type="button" onClick={() => setDeleting(null)}>취소</button></div></div>}</>}</div></section>)}</div><Notice error>{nameError}</Notice><Notice>{nameFeedback}</Notice>{!metadataLocked && !!state.candidates.length && <button className="primary" disabled={busy || uploading}>와인 정보 저장</button>}</form>
    <section className="panel destructive-panel">
      <h2>와인 등록 초기화</h2>
      <p className="muted">{locked
            ? '먼저 투표 진행 화면에서 투표 기록을 초기화해 주세요.'
            : '등록된 와인을 모두 삭제합니다. 참여 정보는 유지됩니다.'}</p>
      <DestructiveAction label="와인 등록 초기화" action={resetWines} busy={busy || uploading} disabled={locked} focusFallback="registered-wines-heading" request={{
            title: '와인 등록을 초기화할까요?',
            description: '등록된 와인과 첨부 사진을 모두 삭제합니다. 다음 와인은 01번부터 등록됩니다. 참여 정보는 유지됩니다.',
            path: '/admin/candidates/reset', method: 'POST', body: { confirm: 'reset-wines', revision: byob.revision },
            success: result => photoCleanupPending(result)
                ? '와인 등록을 초기화했습니다. 일부 사진은 삭제 대기 중입니다.'
                : '와인 등록을 초기화했습니다. 다음 와인은 01번부터 등록됩니다.',
        }}/>
      {state.photoCleanupPending > 0 && <div className="activity-reset">
        <Notice>삭제 대기 중인 사진이 {state.photoCleanupPending}장 있습니다.</Notice>
        <button type="button" disabled={busy || uploading} onClick={retryPhotoCleanup}>사진 정리 다시 시도</button>
      </div>}
    </section>
    <PhotoDialog photo={photo} onClose={() => setPhoto(null)}/></>;
}
export function RankedResponses({ state, action, busy }: {
    state: AdminState;
    action: Action;
    busy: boolean;
}) {
    const [photo, setPhoto] = useState<Candidate | null>(null);
    const [editing, setEditing] = useState(false);
    const [nameError, setNameError] = useState('');
    const [nameFeedback, setNameFeedback] = useState('');
    const saving = useRef(false);
    const form = useRef<HTMLFormElement>(null);
    const editButton = useRef<HTMLButtonElement>(null);
    const wasEditing = useRef(false);
    useEffect(() => {
        if (editing) form.current?.querySelector('input')?.focus();
        else if (wasEditing.current) editButton.current?.focus();
        wasEditing.current = editing;
    }, [editing]);
    const activity = state.activities.find(row => row.id === 'byob')!;
    const rows = state.byobResults ?? [];
    const metadataLocked = activity.started && activity.status !== 'closed';
    async function saveNames(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || metadataLocked || saving.current) return;
        saving.current = true;
        try {
            if (await saveCandidateNames(event, state, action, setNameError, setNameFeedback)) setEditing(false);
        } finally { saving.current = false; }
    }
    return <section className="panel">
    <div className="section-heading"><h2 id="vote-results-heading" tabIndex={-1}>{activity.title}</h2><span>{statusText[activity.status]} · {activity.published ? '결과 공개됨' : '결과 비공개 (관리자만)'}</span></div>
    <p className="muted">투표 {state.submittedCount}건</p>
    {rows.length ? <form ref={form} onSubmit={saveNames} onChange={() => { setNameError(''); setNameFeedback(''); }}>
      <RankedResultList rows={rows} onPhoto={setPhoto} method={activity.votingMethod} nameEditor={editing ? row => <ServerTextInput name={row.candidateId} aria-label={'와인 ' + row.number + ' 표시 이름'} serverValue={row.name} required maxLength={maxWineNameLength} disabled={busy || metadataLocked}/> : undefined}/>
      <Notice error>{nameError}</Notice><Notice>{nameFeedback}</Notice>
      {editing ? <div className="row"><button className="primary" disabled={busy || metadataLocked}>와인 이름 저장</button><button type="button" disabled={busy} onClick={() => { setEditing(false); setNameError(''); setNameFeedback(''); }}>수정 취소</button></div>
        : !metadataLocked && <button ref={editButton} type="button" disabled={busy} onClick={() => setEditing(true)}>와인 이름 수정</button>}
    </form> : <p className="muted">아직 등록된 와인이 없습니다.</p>}
    <PhotoDialog photo={photo} onClose={() => setPhoto(null)}/>
  </section>;
}
