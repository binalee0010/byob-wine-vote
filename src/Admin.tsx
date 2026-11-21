import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes, type TextareaHTMLAttributes, type MouseEvent } from 'react';
import QRCode from 'qrcode';
import { api, apiPath, ApiError, getMemberCsrfToken, statusText, type Activity, type AdminActivity, type AdminState, type Candidate, type Member } from './api';
import { Notice, PhotoDialog, RankedResultList, Status } from './App';
import CandidatePhoto from './CandidatePhoto';
import { preparePhoto } from './image';
import { submissionStatusText, votingMethodInfo } from './format';
import { candidateNameChanges, customRankCount, keepProgressEdits, maxRankCount, progressDraftChanges, passwordChangeError, progressFieldKey, progressServerFields, progressSettingsUpdate, useServerDraft } from './forms';
import DestructiveAction, { type Action } from './DestructiveAction';
import VoteHistory from './VoteHistory';
import { AdminHeader } from './SiteChrome';
const voteTabs = ['투표 진행', '제출 현황', '후보 등록', '투표 결과'];
type ChangePassword = (currentPassword: string, newPassword: string) => Promise<void>;
type SettingField = (key: string, fallback?: string) => {
    form: string;
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
};
function ServerTextInput({ serverValue, ...props }: {
    serverValue: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange'>) {
    const [value, setValue] = useServerDraft(serverValue);
    return <input {...props} value={value} onChange={e => setValue(e.target.value)}/>;
}
function ServerTextArea({ serverValue, ...props }: { serverValue: string } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'onChange'>) {
    const [value, setValue] = useServerDraft(serverValue);
    return <textarea {...props} value={value} onChange={event => setValue(event.target.value)}/>;
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
    const refresh = useCallback(async () => {
        if (passwordChanging.current) return;
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
    const participantUrl = state?.participantUrl ?? new URL(member ? '/v/' + encodeURIComponent(pollSlug ?? member.workspaceSlug ?? '') : '/', location.origin).href;
    return <div className="admin-shell"><AdminHeader title={eventTitle || '투표 관리'} participantUrl={participantUrl} pollListUrl={member ? '/admin' : undefined} onSettings={onSettings} onLogout={member ? onLogout : state ? () => { void legacyLogout(); } : undefined} busy={busy || uploadBusy || loggingOut}/><main><Notice error>{sessionError}</Notice><Notice error>{connectionError}</Notice><Notice error>{error}</Notice><Notice>{message}</Notice>{!state && !member && !legacyChecking
            ? <section className="panel login-panel"><h2>관리자 로그인</h2><form onSubmit={legacyLogin}><label>비밀번호<input ref={loginInput} type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)}/></label><button className="primary" disabled={busy || !password}>{busy ? '확인 중…' : '로그인'}</button></form></section>
            : !state
            ? connectionError ? <button type="button" onClick={() => { setConnectionError(''); void refresh(); }}>다시 불러오기</button> : <p role="status">내 투표를 불러오고 있습니다…</p>
            : <><nav className="admin-tabs" aria-label="관리 메뉴">{voteTabs.map((title, index) => <button key={title} aria-current={tab === index ? 'page' : undefined} className={tab === index ? 'active' : ''} onClick={() => { setTab(index); setMessage(''); setError(''); }}>{title}</button>)}</nav>
    <div hidden={tab !== 0}><Progress state={state} action={action} busy={busy || uploadBusy} changePassword={member ? undefined : legacyChangePassword} onResetAll={() => setRegistrationDraftVersion(value => value + 1)}/></div>
    <div hidden={tab !== 1}><Participants state={state}/></div>
    <div hidden={tab !== 2}><Candidates key={registrationDraftVersion} state={state} action={action} busy={busy} refresh={refresh} onUploadBusy={setUploadBusy}/></div>
    <div hidden={tab !== 3}><RankedResponses key={state.activities[0].revision} state={state} action={action} busy={busy || uploadBusy}/>{tab === 3 && <VoteHistory />}</div>
  </>}</main></div>;
}
export function Progress({ state, action, busy, changePassword, onResetAll }: {
    state: AdminState;
    action: Action;
    busy: boolean;
    changePassword?: ChangePassword;
    onResetAll?: () => void;
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
    useEffect(() => { QRCode.toDataURL(participantUrl, { width: 256, margin: 2, color: { dark: '#682339', light: '#ffffff' } }).then(setQr).catch(() => setCopied('QR 코드를 만들지 못했습니다. 주소를 복사해 주세요.')); }, [participantUrl]);
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
    return <div className="admin-grid">
    <section className="panel">
      <h2>투표 정보</h2>
      <div className="progress-fields">
        <label>투표 제목<input {...field('event:title')} maxLength={120} required disabled={busy}/></label>
      </div>
    </section>
    <section className="panel share-panel">
      <div><h2>투표 링크</h2>
        <a className="share-url" href={participantUrl} target="_blank" rel="noreferrer">{participantUrl}</a>
        <button className="secondary" type="button" onClick={copy}>주소 복사</button><Notice>{copied}</Notice>
      </div>{qr && <img className="qr" src={qr} alt="참가자 입장 주소 QR 코드"/>}
    </section>
    <section className="full-width">
      <div className="section-heading"><h2 id="activity-progress-heading" tabIndex={-1}>진행 상태</h2>
        {dirty ? <span>설정을 모두 저장한 뒤 시작할 수 있습니다.</span> : false}
      </div>
      <div className="ranked-activity">{state.activities.map(activity => <ActivityControl key={activity.id + ':' + activity.revision} activity={activity} count={state.submittedCount} total={state.participants.length} action={action} busy={busy} field={field} startBlocked={dirty}/>)}</div>
    </section>
    <form id="progress-settings" className="full-width settings-save" onSubmit={saveSettings}>
      <Notice error>{saveError}</Notice>
      <button className="primary" disabled={busy || !dirty}>설정 모두 저장</button>
    </form>
    {changePassword && <PasswordChange busy={busy} onChangePassword={changePassword}/>}
    {<section className="panel full-width destructive-panel">
      <h2>현재 투표 전체 초기화</h2>
      <p className="muted">현재 참가자, 와인과 응답을 삭제하고 투표를 대기로 되돌립니다. 현재 결과는 삭제되며, 이전에 저장된 기록은 유지됩니다.</p>
      <DestructiveAction label="전체 초기화" action={resetAll} busy={busy} request={{
                title: '현재 투표를 전체 초기화할까요?',
                description: `이 투표의 참가 기록과 세션, 와인 ${state.candidates?.length ?? 0}개와 사진, 투표 ${responseCount}건과 현재 결과를 삭제합니다. 투표 제목·방식·배점, 계정 비밀번호와 세션, 이전에 저장된 기록과 기록에 저장된 사진은 유지됩니다. 이 작업은 되돌릴 수 없습니다.`,
                path: '/admin/reset-all', method: 'POST', body: { confirm: 'reset-all', expectedRevision: expectedRevisions.byob, expectedRosterRevision: state.rosterRevision },
                phrase: '전체 초기화', success: result => photoCleanupPending(result)
                    ? '현재 투표를 초기화했습니다. 후보 등록 화면에서 남은 사진을 정리할 수 있습니다.'
                    : '현재 투표를 초기화했습니다. 이전에 저장된 기록은 유지됩니다.',
            }}/>
    </section>}</div>;
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
export function VotingMethodSetting({ activity, busy, field }: {
    activity: Activity;
    busy: boolean;
    field: SettingField;
}) {
    const method = field(progressFieldKey(activity, 'votingMethod'), activity.votingMethod ?? 'full');
    const count = field(progressFieldKey(activity, 'rankCount'), String(activity.rankPoints?.length ?? 2));
    return <>
    <label>투표 방식<select className="activity-reveal-select" {...method} disabled={activity.started || busy}>
      <option value="winner">{votingMethodInfo.winner.label} · 1표</option>
      <option value="full">{votingMethodInfo.full.label} · 1위는 와인 수만큼, 꼴등은 1점</option>
      <option value="custom">{votingMethodInfo.custom.label}</option>
    </select></label>
    {method.value === 'custom' && <>
      <label>선택 개수 <small>1~{maxRankCount}개</small><input {...count} inputMode="numeric" maxLength={3} disabled={activity.started || busy}/></label>
      <div className="rank-point-fields">{Array.from({ length: customRankCount(count.value) }, (_, place) => <label key={place}>{place + 1}위 배점
        <input {...field(progressFieldKey(activity, `rankPoint:${place}`), activity.rankPoints?.[place]?.toString())} inputMode="numeric" maxLength={7} disabled={activity.started || busy}/>
      </label>)}</div>
      <small>배점은 0~1,000,000점 사이의 정수로, 한 순위 이상은 1점 이상이어야 합니다.</small>
    </>}
    {activity.started && <small>투표를 시작했습니다. 투표 리셋 후 방식을 바꿀 수 있습니다.</small>}
  </>;
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
    const visibility = field(progressFieldKey(activity, 'resultVisibility'));
    const visibilityHelp = `${activity.id}-result-visibility-help`;
    const visibilityChanged = visibility.value !== activity.resultVisibility;
    const willPublishOnClose = activity.resultVisibility === 'public';
    const resultsLocked = activity.resultsLocked || activity.published;
    const startDisabled = busy || startBlocked || resultsLocked || activity.status === 'open';
    const closeDisabled = busy || activity.status !== 'open' || visibilityChanged;
    const confirmDisabled = confirm === 'open' ? startDisabled : closeDisabled;
    return <article className="panel activity-control">
    <div className="row spread"><p className="eyebrow">투표</p><Status activity={activity}/></div>
    <div className="progress-fields">
      <label>투표 질문<input {...field(progressFieldKey(activity, 'title'))} maxLength={120} required disabled={busy}/></label>
      <VotingMethodSetting activity={activity} busy={busy} field={field}/>
      {<div>
        <label>결과 공개<select className="activity-reveal-select" {...visibility} disabled={busy} aria-describedby={visibilityHelp}>
          <option value="private">나만 보기</option>
          <option value="public">다 공개하기</option>
        </select></label>
        <small id={visibilityHelp}>
          {visibility.value === 'public'
                ? activity.status === 'closed'
                    ? activity.published ? '참가자에게 결과가 공개되어 있습니다.' : '저장하면 참가자가 결과를 볼 수 있습니다.'
                    : visibilityChanged ? '저장한 뒤 마감하면 참가자에게 결과가 자동으로 공개됩니다.' : '마감하면 참가자에게 결과가 자동으로 공개됩니다.'
                : '관리자만 결과를 확인할 수 있습니다.'}
          {activity.status === 'open' && visibilityChanged && ' 결과 공개 설정을 저장한 뒤 마감할 수 있습니다.'}
          {resultsLocked ? ' 결과를 공개했거나 이전에 기록을 저장한 투표는 다시 시작할 수 없습니다.' : visibility.value === 'public' && ' 결과를 공개한 뒤에는 다시 시작할 수 없습니다.'}
        </small>
      </div>}
    </div>
    <p className="count"><strong>{count}</strong> / {total}<span>명 제출</span></p>
    <div className="control-actions">
      <button type="button" className="primary" disabled={startDisabled} onClick={() => setConfirm('open')}>{activity.started ? '다시 시작' : '시작'}</button>
      <button type="button" disabled={closeDisabled} onClick={() => setConfirm('close')}>마감</button>
    </div>
    {confirm && <div className="confirm-box">
      <p>{confirm === 'close' ? <>
        지금 참여를 마감할까요?
        {willPublishOnClose && ' 마감하면 결과가 자동으로 공개됩니다. 공개 후에는 다시 시작할 수 없습니다.'}
      </> : `${votingMethodInfo[activity.votingMethod ?? 'full'].label} 방식으로 투표를 열까요? 시작 후 방식과 와인은 변경할 수 없습니다.`}</p>
      <div className="row">
        <button type="button" className="primary" disabled={confirmDisabled} onClick={async () => {
                if (confirmDisabled)
                    return;
                if (await action('/admin/activities/' + activity.id + '/state', 'POST', { action: confirm, revision: activity.revision }))
                    setConfirm(null);
            }}>확인</button>
        <button type="button" disabled={busy} onClick={() => setConfirm(null)}>취소</button>
      </div>
    </div>}
    <div className="activity-reset">
      <DestructiveAction label="투표 리셋" accessibleLabel={activity.title + ' 리셋'} action={action} busy={busy} focusFallback="activity-progress-heading" request={{
            title: activity.title + ' 리셋',
            description: `투표 ${count}건을 삭제합니다. 대기 상태로 돌아가며 결과 공개 설정은 ‘나만 보기’로 바뀌고 잠금이 풀립니다. 참여 정보, 와인과 사진, 투표 정보는 유지됩니다.`,
            path: '/admin/activities/' + activity.id + '/reset', method: 'POST',
            body: { confirm: 'reset', expectedRevision: activity.revision }, success: activity.title + ' 투표를 대기로 돌리고 응답과 결과를 지웠습니다.',
        }}/>
    </div>
  </article>;
}
export function Participants({ state }: { state: AdminState }) {
    return <section className="panel">
      <h2>제출 현황</h2>
      {state.participants.length > 0 && <p className="muted">{`참여자 ${state.participants.length}명 중 ${state.submittedCount}명 제출 완료`}</p>}
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
    name: string;
    state: 'ready' | 'compressing' | 'uploading' | 'done' | 'error';
    progress: number;
    error?: string;
    prepared?: File;
};
export function sendPhoto(upload: Upload, file: File, onProgress: (value: number) => void): Promise<void> { return new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('POST', apiPath('/admin/candidates')); const csrf = getMemberCsrfToken(); if (csrf) xhr.setRequestHeader('X-Member-CSRF', csrf); xhr.responseType = 'json'; xhr.timeout = 45000; xhr.upload.onprogress = e => { if (e.lengthComputable)
    onProgress(Math.round(e.loaded / e.total * 100)); }; xhr.onload = () => { const data = xhr.response as {
    candidate?: Candidate;
    error?: string;
} | null; if (xhr.status >= 200 && xhr.status < 300 && data?.candidate?.id)
    resolve();
else
    reject(new Error(data?.error || '업로드하지 못했습니다. 다시 시도해 주세요.')); }; xhr.onerror = xhr.ontimeout = () => reject(new Error('연결이 끊겼습니다. 다시 시도하면 같은 사진이 중복 등록되지 않습니다.')); const form = new FormData(); form.set('file', file); form.set('name', upload.name); form.set('requestId', upload.id); form.set('revision', String(upload.revision)); xhr.send(form); }); }
export async function submitCandidateUploads(uploads: Upload[], revision: number, update: (id: string, patch: Partial<Upload>) => void, refresh: () => Promise<void>) {
    for (const upload of uploads) {
        if (upload.revision !== revision || (upload.state !== 'ready' && upload.state !== 'error'))
            continue;
        try {
            if (upload.file) {
                update(upload.id, { state: 'compressing', error: '' });
                const file = upload.prepared || await preparePhoto(upload.file);
                update(upload.id, { state: 'uploading', prepared: file, progress: 0 });
                await sendPhoto(upload, file, progress => update(upload.id, { progress }));
            }
            else {
                update(upload.id, { state: 'uploading', error: '' });
                const { candidate } = await api<{
                    candidate: Candidate;
                }>('/admin/candidates', 'POST', { name: upload.name, requestId: upload.id, revision: upload.revision });
                if (!candidate?.id)
                    throw new Error('등록 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
            }
            update(upload.id, { state: 'done', progress: 100 });
            await refresh();
        }
        catch (e) {
            update(upload.id, { state: 'error', error: (e as Error).message });
        }
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
    const uploadable = uploads.filter(row => row.revision === byob.revision && (row.state === 'ready' || row.state === 'error'));
    const staleNames = namesDraft !== null && namesDraft.revision !== byob.revision;
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
    return <><section className="panel"><h2>와인</h2><p className="muted">사진을 선택하거나 이름만 입력해 등록할 수 있습니다. JPEG·PNG·WebP 사진을 사용할 수 있습니다.</p>{locked ? <Notice>{metadataLocked ? '투표 진행 중에는 와인 정보를 변경할 수 없습니다.' : '마감된 투표의 이름과 설명을 수정할 수 있습니다. 사진, 순서와 투표 결과는 유지됩니다.'}</Notice> : <><label className="file-picker">와인 사진 선택<input type="file" accept="image/jpeg,image/png,image/webp,.heic,.heif" multiple disabled={uploading || busy} onChange={e => { const files = Array.from(e.target.files || []); setUploads(old => [...old, ...files.map((file, index) => ({ id: crypto.randomUUID(), revision: byob.revision, file, name: `와인 ${String(state.candidates.length + old.filter(u => u.state !== 'done').length + index + 1).padStart(2, '0')}`, state: 'ready' as const, progress: 0 }))]); e.target.value = ''; }}/></label><small>사진 방향을 바로잡고 긴 변 1,600px, 2MB 이하로 줄여 등록합니다. HEIC는 JPEG·PNG로 변환해 주세요.</small>
    <form className="wine-name-form" onSubmit={registerNames}>
      <label>사진 없이 등록
        <textarea value={namesDraft?.text ?? ''} disabled={uploading || busy || staleNames} rows={3} placeholder="와인 이름을 한 줄에 하나씩 입력" onChange={event => {
                setNamesDraft({ text: event.target.value, revision: byob.revision });
                setRegistrationError('');
            }}/>
      </label>
      <Notice error>{registrationError}</Notice>
      {staleNames
                ? <><Notice>투표가 리셋되어 이전에 입력한 이름은 등록할 수 없습니다.</Notice><button type="button" disabled={uploading || busy} onClick={() => { setNamesDraft(null); setRegistrationError(''); }}>이전 입력 지우기</button></>
                : <button type="submit" className="secondary" disabled={uploading || busy || !namesDraft?.text.trim()}>이름만 등록</button>}
    </form></>}{uploads.length > 0 && <div className="upload-list">{uploads.map(upload => <div className={'upload-row ' + upload.state} key={upload.id}><div><small className="filename">{upload.file?.name ?? "사진 없이 등록"}</small><label>표시 이름<input maxLength={maxWineNameLength} value={upload.name} disabled={uploading || locked || upload.revision !== byob.revision || upload.state === 'done' || upload.state === 'error'} onChange={e => update(upload.id, { name: e.target.value })}/></label></div><div className="upload-status"><strong>{upload.state === 'done' ? '✓ 등록 완료' : upload.state === 'compressing' ? '사진 처리 중…' : upload.state === 'uploading' ? (upload.file ? `업로드 ${upload.progress}%` : '등록 중…') : upload.state === 'error' ? '등록 실패' : '등록 대기'}</strong>{upload.state === 'uploading' && upload.file && <progress max={100} value={upload.progress} aria-label={upload.file.name + ' 업로드 진행률'}/>}{upload.revision !== byob.revision && upload.state !== 'done' ? <p>{upload.file ? "투표가 리셋되었습니다. 이 사진은 다시 선택해 주세요." : "투표가 리셋되었습니다. 이 이름은 다시 입력해 주세요."}</p> : upload.error && <p role="alert">{upload.error}</p>}</div></div>)}</div>}{!locked && uploadable.length > 0 && <button className="primary" disabled={uploading || busy || uploadable.some(row => !row.name.trim())} onClick={() => void uploadAll(uploadable)}>{uploading ? '와인을 등록하고 있습니다…' : uploadable.some(row => row.state === 'error') ? '대기·실패 와인 등록' : '선택한 사진 등록'}</button>}</section><div className="section-heading"><h2 id="registered-wines-heading" tabIndex={-1}>등록된 와인 {state.candidates.length}개</h2><span>위에서부터 참가자 화면에 표시됩니다.</span></div><form className="candidate-names-form" onSubmit={saveNames} onChange={() => { setNameError(''); setNameFeedback(''); }}><div className="candidate-grid admin-candidates">{state.candidates.map((candidate, index) => <section className="candidate-card" key={candidate.id + ":" + byob.revision}><CandidatePhoto candidate={candidate} onPhoto={setPhoto}/><div className="candidate-editor"><p className="eyebrow">와인 {String(candidate.number).padStart(2, '0')}</p><label>표시 이름<ServerTextInput name={candidate.id} aria-label={'와인 ' + candidate.number + ' 표시 이름'} serverValue={candidate.name} required maxLength={maxWineNameLength} disabled={metadataLocked || uploading || busy}/></label><label>설명 (선택)<ServerTextArea name={'description:' + candidate.id} aria-label={'와인 ' + candidate.number + ' 설명'} serverValue={candidate.description ?? ''} maxLength={2000} rows={3} disabled={metadataLocked || uploading || busy}/></label>{!locked && <><div className="row"><button type="button" aria-label={candidate.name + ' 위로 이동'} disabled={busy || uploading || index === 0} onClick={() => move(index, -1)}>↑ 위로</button><button type="button" aria-label={candidate.name + ' 아래로 이동'} disabled={busy || uploading || index === state.candidates.length - 1} onClick={() => move(index, 1)}>↓ 아래로</button><button type="button" className="danger" disabled={busy || uploading} onClick={() => setDeleting({ id: candidate.id, revision: byob.revision })}>삭제</button></div>{deleting?.id === candidate.id && deleting.revision === byob.revision && <div className="confirm-box"><p>이 와인을 삭제할까요?</p><div className="row"><button type="button" className="danger" disabled={busy || uploading} onClick={async () => { if (await action('/admin/candidates/' + candidate.id, 'DELETE', { revision: deleting.revision }))
        setDeleting(null); }}>삭제 확인</button><button type="button" onClick={() => setDeleting(null)}>취소</button></div></div>}</>}</div></section>)}</div><Notice error>{nameError}</Notice><Notice>{nameFeedback}</Notice>{!metadataLocked && !!state.candidates.length && <button className="primary" disabled={busy || uploading}>와인 정보 저장</button>}</form>
    <section className="panel destructive-panel">
      <h2>와인 등록 초기화</h2>
      <p className="muted">{locked
            ? '먼저 투표 진행 화면에서 투표를 리셋해 주세요.'
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
    <p className="muted">투표 {state.submittedCount}건 · {activity.votingMethod === 'winner' ? '득표수가' : '총점이'} 같으면 공동 순위입니다.</p>
    {rows.length ? <form ref={form} onSubmit={saveNames} onChange={() => { setNameError(''); setNameFeedback(''); }}>
      <RankedResultList rows={rows} onPhoto={setPhoto} method={activity.votingMethod} nameEditor={editing ? row => <ServerTextInput name={row.candidateId} aria-label={'와인 ' + row.number + ' 표시 이름'} serverValue={row.name} required maxLength={maxWineNameLength} disabled={busy || metadataLocked}/> : undefined}/>
      <Notice error>{nameError}</Notice><Notice>{nameFeedback}</Notice>
      {editing ? <div className="row"><button className="primary" disabled={busy || metadataLocked}>와인 이름 저장</button><button type="button" disabled={busy} onClick={() => { setEditing(false); setNameError(''); setNameFeedback(''); }}>수정 취소</button></div>
        : !metadataLocked && <button ref={editButton} type="button" disabled={busy} onClick={() => setEditing(true)}>와인 이름 수정</button>}
    </form> : <p className="muted">아직 등록된 와인이 없습니다.</p>}
    <PhotoDialog photo={photo} onClose={() => setPhoto(null)}/>
  </section>;
}
