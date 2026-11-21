import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, statusText, type Activity } from './api';
import { siteTitle } from './branding';
import { Notice, SiteHeader } from './SiteChrome';
import DestructiveAction, { type Action } from './DestructiveAction';

type Poll = { slug: string; title: string; status: Activity['status'] };

export default function MemberPolls({ onSettings, onLogout, loggingOut, sessionError, onSessionEnded }: { onSettings: () => void; onLogout: () => void; loggingOut: boolean; sessionError: string; onSessionEnded: () => void }) {
  const [polls, setPolls] = useState<Poll[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  const submitting = useRef(false);
  const draft = useRef<{ title: string; requestId: string } | null>(null);
  const refresh = useCallback(async () => {
    const next = await api<{ polls: Poll[] }>('/members/polls');
    if (!Array.isArray(next.polls)) throw new Error('내 투표를 불러오지 못했습니다. 다시 시도해 주세요.');
    setPolls(next.polls);
  }, []);
  useEffect(() => { document.title = siteTitle + ' · 내 투표 목록'; }, []);
  useEffect(() => {
    let stopped = false;
    void api<{ polls: Poll[] }>('/members/polls').then(next => {
      if (!Array.isArray(next.polls)) throw new Error('내 투표를 불러오지 못했습니다. 다시 시도해 주세요.');
      if (!stopped) setPolls(next.polls);
    }).catch(failure => {
      if (!stopped) { if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionEnded(); else setError((failure as Error).message); }
    });
    return () => { stopped = true; };
  }, [onSessionEnded]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !title.trim()) return;
    submitting.current = true; setBusy(true); setError(''); setFeedback('');
    if (draft.current?.title !== title) draft.current = { title, requestId: crypto.randomUUID() };
    try {
      const { poll } = await api<{ poll: Poll }>('/members/polls', 'POST', draft.current);
      if (!poll || !/^[a-z0-9-]+$/.test(poll.slug)) throw new Error('만든 투표를 확인하지 못했습니다. 다시 시도해 주세요.');
      setEntering(true); location.assign('/admin/p/' + encodeURIComponent(poll.slug)); return;
    } catch (failure) {
      setEntering(false);
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionEnded(); else setError((failure as Error).message);
    }
    submitting.current = false; setBusy(false);
  }
  const removePoll: Action = async (path, method, body, notice) => {
    if (submitting.current || loggingOut) return false;
    submitting.current = true; setBusy(true); setError(''); setFeedback('');
    try {
      const result = await api<{ ok: boolean; slug: string }>(path, method, body);
      if (!result.ok || path !== '/members/polls/' + encodeURIComponent(result.slug)) {
        throw new Error('삭제 결과를 확인하지 못했습니다. 다시 시도해 주세요.');
      }
      setPolls(current => current?.filter(poll => poll.slug !== result.slug) ?? null);
      setFeedback('투표를 삭제했습니다.');
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onSessionEnded();
      else notice?.error?.((failure as Error).message);
      return false;
    } finally {
      submitting.current = false; setBusy(false);
    }
  };
  return <div className="participant-shell ballot-shell member-shell member-polls"><SiteHeader title={siteTitle}><div className="admin-header-actions"><button type="button" disabled={busy || loggingOut} onClick={onSettings} aria-haspopup="dialog">계정 설정</button><button type="button" disabled={busy || loggingOut} onClick={onLogout}>로그아웃</button></div></SiteHeader><main>
    <h2>내 투표 목록</h2><Notice error>{sessionError}</Notice><Notice error>{error}</Notice>
    {entering ? <p className="loading" role="status">투표를 열고 있어요…</p> : <>
      <section className="panel"><h2>새 투표 만들기</h2><form onSubmit={create}><fieldset disabled={busy}>
        <label>투표 제목<input name="title" required maxLength={120} value={title} onChange={event => setTitle(event.target.value)}/></label>
        <button type="submit" className="primary" disabled={busy || !title.trim()}>투표 만들기</button>
      </fieldset></form></section>
      <section className="panel"><h2 id="created-polls-heading" tabIndex={-1}>만든 투표</h2><Notice>{feedback}</Notice>{polls === null ? error ? <button type="button" onClick={() => { setError(''); void refresh().catch(failure => { if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionEnded(); else setError((failure as Error).message); }); }}>다시 불러오기</button> : <p role="status">내 투표를 불러오고 있어요…</p>
        : polls.length ? <ul className="member-poll-list">{polls.map(poll => <li key={poll.slug}>
          <a href={'/admin/p/' + encodeURIComponent(poll.slug)}>{poll.title}</a>
          <span className={'badge ' + poll.status}>{statusText[poll.status]}</span>
          <DestructiveAction label="삭제" accessibleLabel={poll.title + ' 투표 삭제'} busy={busy || loggingOut}
            focusFallback="created-polls-heading" action={removePoll}
            request={{title:'‘' + poll.title + '’ 투표를 삭제할까요?', description:'삭제하면 이 투표의 참가 링크가 닫히고 응답과 결과를 다시 볼 수 없습니다.',
              path:'/members/polls/' + encodeURIComponent(poll.slug), method:'DELETE', body:{confirm:'delete-poll'}, success:'투표를 삭제했습니다.'}} />
        </li>)}</ul> : <p className="muted">아직 만든 투표가 없습니다.</p>}</section>
    </>}
  </main></div>;
}
