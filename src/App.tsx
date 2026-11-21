import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type SetStateAction } from 'react';
import { api, ApiError, isParticipantChanged, participantChangedMessage, saveActivityAnswer, statusText, type Activity, type Bootstrap, type ByobResult, type Candidate, type Detail, type Id, type Participant, type Results, type VotingMethod } from './api';
import MemberPortal from './MemberPortal';
import Admin from './Admin';
import { rankLabel, submissionStatusText } from './format';
import { isCompleteRanking, moveCandidateRank, selectCustomRank } from './forms';
import RankedBallot from './RankedBallot';
import CandidatePhoto from './CandidatePhoto';
import { siteTitle } from './branding';
import { Notice, SiteHeader } from './SiteChrome';
export { Notice };
export function Status({ activity }: {
    activity: Activity;
}) { return <span className={'badge ' + activity.status}>{activity.status === 'waiting' ? '대기' : statusText[activity.status]}</span>; }
export function PhotoDialog({ photo, onClose }: {
    photo: Candidate | null;
    onClose: () => void;
}) {
    const titleId = useId();
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => { if (photo) {
        const previous = document.activeElement as HTMLElement | null;
        ref.current?.showModal();
        return () => { ref.current?.close(); previous?.focus(); };
    } }, [photo]);
    return <dialog ref={ref} className="photo-dialog" aria-labelledby={titleId} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget)
        onClose(); }}><div className="row spread"><h2 id={titleId}>{photo?.name}</h2><button type="button" onClick={onClose} aria-label="와인 상세 닫기">닫기</button></div>{photo?.description && <p className="candidate-description">{photo.description}</p>}{photo?.photoUrl && <img src={photo.photoUrl} alt={photo.name + ' 확대 사진'}/>}</dialog>;
}
export default function App() {
    const [standalone, setStandalone] = useState(false);
    const useStandalone = useCallback(() => setStandalone(true), []);
    if (/^\/v\/[^/]+\/?$/.test(location.pathname)) return <ParticipantApp />;
    if (standalone) return location.pathname.startsWith('/admin') ? <Admin /> : <ParticipantApp />;
    return <MemberPortal onStandalone={useStandalone}/>;
}
type EventView = {
    id: Id;
    results: boolean;
    revision: number;
    resultVisibility?: Activity['resultVisibility'];
};
type ViewChangeReason = 'reset' | 'private' | 'participant';
const resultHiddenNotice = '결과가 비공개로 전환되었습니다.';
export function viewChangeReason(activity: Activity | undefined, view: EventView): ViewChangeReason | null {
    if (activity?.id !== view.id || activity.revision !== view.revision)
        return 'reset';
    if (view.results && (!activity.published || (view.resultVisibility !== undefined && activity.resultVisibility !== view.resultVisibility)))
        return 'private';
    return null;
}
export function isCurrentView(activity: Activity | undefined, view: EventView) { return viewChangeReason(activity, view) === null; }
function ParticipantApp() {
    const [data, setData] = useState<Bootstrap | null>(null);
    const eventTitle = data?.event.title;
    useEffect(() => { document.title = eventTitle || siteTitle; }, [eventTitle]);
    const [error, setError] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState('');
    const [changingName, setChangingName] = useState(false);
    const pollEpoch = useRef(0);
    const previousRankedActivity = useRef<Activity | undefined>(undefined);
    const refresh = useCallback(async () => {
        const epoch = ++pollEpoch.current;
        try {
            const next = await api<Bootstrap>('/bootstrap');
            if (typeof next.event?.title !== 'string' || !Array.isArray(next.activities))
                throw new Error('투표 정보를 불러오지 못했습니다. 다시 시도해 주세요.');
            if (epoch === pollEpoch.current) {
                setData(next);
                setConnectionError('');
            }
            return next;
        }
        catch (error) {
            if (epoch === pollEpoch.current) {
                if (error instanceof ApiError && (error.status === 404 || error.status === 410)) setData(null);
                setConnectionError((error as Error).message);
            }
            throw error;
        }
    }, []);
    useEffect(() => { let stopped = false; let timer: number; const poll = async () => { await refresh().catch(() => { }); if (!stopped)
        timer = window.setTimeout(poll, 3000); }; void poll(); return () => { stopped = true; ++pollEpoch.current; clearTimeout(timer); }; }, [refresh]);
    const rankedActivity = data?.activities.find(activity => activity.id === 'byob');
    useEffect(() => {
        const previous = previousRankedActivity.current;
        previousRankedActivity.current = rankedActivity;
        if (!previous || !rankedActivity)
            return;
        if (previous.revision !== rankedActivity.revision) {
            setNotice('투표가 리셋되었습니다.');
        }
        else if (previous.published && !rankedActivity.published) {
            setNotice(resultHiddenNotice);
            window.requestAnimationFrame(() => document.getElementById('ranked-vote-heading')?.focus());
        }
        else if (!previous.published && rankedActivity.published) {
            setNotice('');
        }
    }, [rankedActivity]);
    const refreshRankedView = useCallback((_view: EventView, reason?: ViewChangeReason) => {
        if (reason === 'participant')
            setNotice(participantChangedMessage);
        void refresh().catch(() => { });
    }, [refresh]);
    async function verify(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            ++pollEpoch.current;
            await api('/session', 'POST', { name });
            await refresh();
            setChangingName(false);
            setName('');
            setNotice('');
            window.requestAnimationFrame(() => document.getElementById('ranked-vote-heading')?.focus());
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    async function logout() { setBusy(true); try {
        ++pollEpoch.current;
        await api('/session', 'DELETE');
        setData(old => old && ({ ...old, participant: null }));
        setNotice('');
        await refresh();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    if (!data)
        return <div className="participant-shell ballot-shell"><main>{connectionError ? <>
    <Notice error>{connectionError}</Notice><button type="button" onClick={() => { setConnectionError(''); void refresh().catch(() => { }); }}>다시 불러오기</button>
  </> : <p className="loading" role="status">투표를 불러오고 있어요…</p>}</main></div>;
    const participantResults = rankedActivity?.status === 'closed' && rankedActivity.resultVisibility === 'participants';
    const identity = !data.participant || changingName
        ? <section className="panel identity"><form onSubmit={verify}>
      <label htmlFor="participant-name">{participantResults ? '이 투표에 참여했던 이름' : '참여할 이름'}</label>
      <div className="input-action">
        <input id="participant-name" autoComplete="name" maxLength={80} required value={name} onChange={e => setName(e.target.value)} placeholder="이름"/>
        <button className="primary" disabled={busy || !name.trim()}>{busy ? '확인 중…' : participantResults ? '결과 보기' : '참여하기'}</button>
      </div>
      {!participantResults && <small>동명이인은 서로 다른 이름을 입력해 주세요.</small>}
      {changingName && <button type="button" className="text-button" onClick={() => setChangingName(false)}>취소</button>}
    </form></section>
        : <section className="identity-bar"><div><strong>{data.participant.name}</strong> 님</div><div className="row"><button className="text-button" onClick={() => { setChangingName(true); setNotice(''); }}>이름 변경</button><button className="text-button" disabled={busy} onClick={logout}>로그아웃</button></div></section>;
    return <div className="participant-shell ballot-shell">
    <SiteHeader title={eventTitle || siteTitle}/>
    <main id="main-content">
      <Notice error>{connectionError}</Notice><Notice error>{error}</Notice><Notice>{notice}</Notice>
      {(!rankedActivity?.published || participantResults || data.participant) && identity}
      {rankedActivity && !(rankedActivity.published && connectionError) && <RankedVote key={rankedActivity.revision + ':' + rankedActivity.published + ':' + rankedActivity.resultVisibility + ':' + (changingName ? '' : data.participant?.id ?? '')} activity={rankedActivity} participant={changingName ? null : data.participant} refresh={refresh} onRevisionChanged={refreshRankedView}/>}
    </main>
  </div>;
}
export function RankedVote({ activity, participant, refresh, onRevisionChanged }: {
    activity: Activity;
    participant: Participant | null;
    refresh: () => Promise<Bootstrap>;
    onRevisionChanged: (view: EventView, reason?: ViewChangeReason) => void;
}) {
    const [view] = useState<EventView>(() => ({ id: activity.id, results: activity.published, revision: activity.revision, resultVisibility: activity.resultVisibility }));
    if (activity.status === 'closed' && activity.published && (activity.resultVisibility !== 'participants' || participant))
        return <PublicResults view={view} participantId={activity.resultVisibility === 'participants' ? participant?.id : undefined} onRevisionChanged={onRevisionChanged}/>;
    if (activity.status === 'open' && participant)
        return <AnswerForm key={participant.id} activity={activity} view={view} participantId={participant.id} alreadySubmitted={!!participant.submitted?.byob} onRevisionChanged={onRevisionChanged} onSaved={async () => {
                const next = await refresh();
                if (!isCurrentView(next.activities.find(row => row.id === view.id), view))
                    return false;
                if (next.participant?.id !== participant.id) {
                    onRevisionChanged(view, 'participant');
                    return false;
                }
                if (!next.participant.submitted?.byob)
                    throw new Error('제출 상태를 확인하지 못했습니다.');
                return true;
            }}/>;
    return <section className="panel ballot-status">
    <div className="row spread"><h2 id="ranked-vote-heading" tabIndex={-1}>{activity.title}</h2><Status activity={activity}/></div>
    {activity.status === 'closed' && <>{participant && <p className="submission">{'내 투표 ' + submissionStatusText(!!participant.submitted?.byob)}</p>}<p className="muted">{activity.resultVisibility === 'participants' ? '참여했던 이름으로 로그인하면 결과를 볼 수 있습니다.' : '현재 결과는 공개되지 않았어요.'}</p></>}
  </section>;
}
function AnswerForm({ activity, view, participantId, alreadySubmitted = false, onSaved, onRevisionChanged }: {
    activity: Activity;
    view: EventView;
    participantId: string;
    alreadySubmitted?: boolean;
    onSaved: () => Promise<boolean | void>;
    onRevisionChanged: (view: EventView, reason?: ViewChangeReason) => void;
}) {
    const [detail, setDetail] = useState<Detail | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [photo, setPhoto] = useState<Candidate | null>(null);
    const [ranking, setRanking] = useState<string[]>([]);
    const [saved, setSaved] = useState(false);
    const [participantChanged, setParticipantChanged] = useState(false);
    const loadEpoch = useRef(0);
    const load = useCallback(async () => {
        const epoch = ++loadEpoch.current;
        try {
            const next = await api<Detail>('/activities/' + view.id);
            if (epoch !== loadEpoch.current)
                return;
            if (!isCurrentView(next.activity, view)) {
                onRevisionChanged(view);
                return;
            }
            setDetail(next);
            setError('');
            const candidates = next.candidates ?? [];
            const saved = next.mine?.ranking;
            const initial = (next.activity.votingMethod ?? 'full') === 'full' ? candidates.map(candidate => candidate.id) : [];
            setRanking(saved && isCompleteRanking(saved, candidates, next.selectionCount) ? saved : initial);
        }
        catch (e) {
            if (epoch === loadEpoch.current)
                setError((e as Error).message);
        }
    }, [view, onRevisionChanged]);
    useEffect(() => { void load(); return () => { ++loadEpoch.current; }; }, [load]);
    const candidates = detail?.candidates ?? [];
    const method = detail?.activity.votingMethod ?? activity.votingMethod ?? 'full';
    const rankPoints = detail?.activity.rankPoints ?? activity.rankPoints ?? [];
    const selectionCount = detail?.selectionCount ?? (method === 'custom' ? rankPoints.length : method === 'winner' ? 1 : candidates.length);
    const ready = isCompleteRanking(ranking, candidates, selectionCount);
    const submitted = alreadySubmitted || !!detail?.mine?.ranking;
    function changeRanking(update: SetStateAction<string[]>) {
        setRanking(update);
        setSaved(false);
    }
    const moveRank = (id: string, place: number) => changeRanking(current => moveCandidateRank(current, id, place));
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setError('');
        if (!detail || busy || participantChanged || !ready || activity.status !== 'open')
            return;
        const answer = { ranking };
        setBusy(true);
        setSaved(false);
        try {
            await saveActivityAnswer(detail.activity, participantId, answer);
            try {
                if (await onSaved())
                    setSaved(true);
            }
            catch {
                setError('투표는 저장됐지만 제출 상태를 확인하지 못했습니다. 연결을 확인해 주세요.');
            }
        }
        catch (e) {
            if (isParticipantChanged(e)) {
                setParticipantChanged(true);
                setError(participantChangedMessage);
                onRevisionChanged(view, 'participant');
            }
            else if (e instanceof ApiError && e.code === 'revision_changed')
                onRevisionChanged(view);
            else
                setError((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    const disabled = busy || participantChanged || activity.status !== 'open';
    return <section className="panel answer-panel ranked-answer"><div className="row spread"><h2 id="ranked-vote-heading" tabIndex={-1}>{activity.title}</h2><Status activity={activity}/></div><Notice error>{!detail ? error : ''}</Notice>{!detail ? <>{!error && <p>참여 내용을 불러오는 중이에요.</p>}{error && <button onClick={load}>다시 불러오기</button>}</> : <form onSubmit={submit}>
    {activity.status !== 'open' && <Notice>참여가 마감되어 답변을 제출하거나 수정할 수 없어요.</Notice>}
    {method === 'full' && <RankedBallot candidates={candidates} ranking={ranking} submitted={submitted} disabled={disabled} onMove={moveRank} onPhoto={setPhoto}/>}
    {method === 'custom' && <CustomRankBallot candidates={candidates} ranking={ranking} rankPoints={rankPoints} disabled={disabled} onSelect={(id, place) => changeRanking(current => selectCustomRank(current, id, place, selectionCount))} onMove={moveRank} onPhoto={setPhoto}/>}
    {method === 'winner' && <SingleWineBallot candidates={candidates} selectedId={ranking[0]} disabled={disabled} onSelect={id => changeRanking([id])} onPhoto={setPhoto}/>}
    <Notice error>{error}</Notice>
    {saved && <Notice>투표를 저장했어요.</Notice>}
    <div className="form-footer">{submitted && !saved && <p className="submission done">제출 완료</p>}<button className="primary" disabled={disabled || !ready}>{busy ? '제출 확인 중…' : (submitted ? '수정 내용 제출' : method === 'winner' ? '투표 제출' : '순위 제출')}</button></div></form>}<PhotoDialog photo={photo} onClose={() => setPhoto(null)}/></section>;
}
export function SingleWineBallot({ candidates, selectedId, disabled, onSelect, onPhoto }: {
    candidates: Candidate[];
    selectedId?: string;
    disabled: boolean;
    onSelect: (id: string) => void;
    onPhoto: (candidate: Candidate) => void;
}) {
    const radio = (candidate: Candidate) => <input type="radio" name="wine" value={candidate.id} checked={selectedId === candidate.id} onChange={() => onSelect(candidate.id)} disabled={disabled} required/>;
    return <fieldset className="compact-single-ballot">
    <legend>와인 선택</legend>
    <ul className="ranked-result-list" role="list">
      {candidates.map(candidate => <li className={'single-choice-row' + (selectedId === candidate.id ? ' selected' : '')} key={candidate.id}>
        <CandidatePhoto candidate={candidate} onPhoto={onPhoto} compact/>
        <label className="single-choice-label">
          <span className="ranked-result-wine"><small>와인 {candidate.number}</small><strong>{candidate.name}</strong></span>
          {radio(candidate)}
        </label>
      </li>)}
    </ul>
  </fieldset>;
}
export function CustomRankBallot({ candidates, ranking, rankPoints, disabled, onSelect, onMove, onPhoto }: {
    candidates: Candidate[];
    ranking: string[];
    rankPoints: number[];
    disabled: boolean;
    onSelect: (id: string, place: number | null) => void;
    onMove: (id: string, place: number) => void;
    onPhoto: (candidate: Candidate) => void;
}) {
    const focusAfterMove = useRef<HTMLButtonElement | null>(null);
    useLayoutEffect(() => {
        const button = focusAfterMove.current;
        focusAfterMove.current = null;
        if (!button)
            return;
        const next = button.disabled ? button.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)') : button;
        next?.focus({ preventScroll: true });
    }, [ranking]);
    function move(event: MouseEvent<HTMLButtonElement>, id: string, place: number) {
        focusAfterMove.current = event.currentTarget;
        onMove(id, place);
    }
    return <fieldset className="custom-rank-ballot">
    <legend>{`상위 ${rankPoints.length}개 순위`}</legend>
    <p className="rank-draft" role="status">{ranking.filter(Boolean).length} / {rankPoints.length}개 선택</p>
    {ranking.some(Boolean) && <ol className="custom-rank-summary" aria-label="선택한 순위" role="list">
      {ranking.map((id, place) => {
                const candidate = candidates.find(row => row.id === id);
                if (!candidate)
                    return null;
                return <li key={id}>
          <span><strong>{place + 1}위</strong> {candidate.name}</span>
          {rankPoints.length > 1 && <div className="rank-actions">
            <button type="button" aria-label={`${candidate.name} ${place + 1}위에서 위로 이동`} disabled={disabled || place === 0} onClick={event => move(event, id, place - 1)}>↑</button>
            <button type="button" aria-label={`${candidate.name} ${place + 1}위에서 아래로 이동`} disabled={disabled || place === rankPoints.length - 1} onClick={event => move(event, id, place + 1)}>↓</button>
          </div>}
        </li>;
            })}
    </ol>}
    <ul className="ranked-result-list" role="list">
      {candidates.map(candidate => <li className="custom-rank-row" key={candidate.id}>
        <CandidatePhoto candidate={candidate} onPhoto={onPhoto} compact/>
        <div className="ranked-result-wine"><small>와인 {candidate.number}</small><strong>{candidate.name}</strong></div>
        <select className="activity-reveal-select" aria-label={candidate.name + ' 순위'} disabled={disabled} value={ranking.includes(candidate.id) ? ranking.indexOf(candidate.id) : ''} onChange={event => onSelect(candidate.id, event.target.value === '' ? null : Number(event.target.value))}>
          <option value="">미선택</option>
          {rankPoints.map((points, place) => (!ranking[place] || ranking[place] === candidate.id) && <option key={place} value={place}>{place + 1}위 · {points.toLocaleString('ko-KR')}점</option>)}
        </select>
      </li>)}
    </ul>
  </fieldset>;
}
export function RankedResultList({ rows, onPhoto, method = 'full', nameEditor }: {
    rows: ByobResult[];
    onPhoto: (candidate: Candidate) => void;
    method?: VotingMethod;
    nameEditor?: (row: ByobResult) => ReactNode;
}) {
    const ranks = rows.map(row => row.rank);
    return <ol className="ranked-result-list" role="list" aria-label={method === 'winner' ? '와인별 순위와 득표수' : '와인별 순위와 총점'}>
    {rows.map(row => <li className="ranked-result-row" key={row.candidateId}>
      <strong className="ranked-result-rank">{rankLabel(row.rank, ranks)}</strong>
      <CandidatePhoto candidate={{ ...row, id: row.candidateId }} onPhoto={onPhoto} compact/>
      <div className="ranked-result-wine"><small>와인 {row.number}</small>{nameEditor ? nameEditor(row) : <strong>{row.name}</strong>}</div>
      <strong className="ranked-result-points">{'points' in row ? row.points + '점' : row.votes + '표'}</strong>
    </li>)}
  </ol>;
}
function PublicResults({ view, participantId, onRevisionChanged }: {
    view: EventView;
    participantId?: string;
    onRevisionChanged: (view: EventView, reason?: ViewChangeReason) => void;
}) {
    const [results, setResults] = useState<Results | null>(null);
    const [error, setError] = useState('');
    const [photo, setPhoto] = useState<Candidate | null>(null);
    const loadEpoch = useRef(0);
    const load = useCallback(async () => {
        const epoch = ++loadEpoch.current;
        try {
            const next = await api<Results>('/results/' + view.id);
            if (epoch !== loadEpoch.current) return;
            if ((next.id === 'byob' && next.revision !== undefined && next.revision !== view.revision) || next.participantId !== participantId) {
                setResults(null); setPhoto(null);
                onRevisionChanged(view);
                return;
            }
            setResults(next);
            setError('');
        }
        catch (e) {
            if (epoch !== loadEpoch.current) return;
            setResults(null); setPhoto(null);
            setError((e as Error).message);
            if (e instanceof ApiError && (e.status === 401 || e.status === 403)) onRevisionChanged(view);
        }
    }, [view, participantId, onRevisionChanged]);
    useEffect(() => { let stopped = false; let timer: number; const poll = async () => { await load(); if (!stopped) timer = window.setTimeout(poll, 3000); }; void poll(); return () => { stopped = true; ++loadEpoch.current; clearTimeout(timer); }; }, [load]);
    return <section className="panel results"><h2>{results?.title || '투표 결과'}</h2><Notice error>{error}</Notice>{error && <button onClick={load}>다시 불러오기</button>}{results && <RankedResultList rows={results.rows} onPhoto={setPhoto} method={results.votingMethod}/>}<PhotoDialog photo={photo} onClose={() => setPhoto(null)}/></section>;
}
