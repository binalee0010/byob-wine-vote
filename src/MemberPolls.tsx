import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, statusText, type Activity } from './api';
import { siteTitle } from './branding';
import { Notice, SiteHeader } from './SiteChrome';

type Poll = { slug: string; title: string; status: Activity['status'] };

export default function MemberPolls({ onSettings, onLogout, loggingOut, sessionError, onSessionEnded }: { onSettings: () => void; onLogout: () => void; loggingOut: boolean; sessionError: string; onSessionEnded: () => void }) {
  const [polls, setPolls] = useState<Poll[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
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
    submitting.current = true; setBusy(true); setError('');
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
  return <div className="participant-shell ballot-shell member-shell member-polls"><SiteHeader title={siteTitle}><div className="admin-header-actions"><button type="button" disabled={busy || loggingOut} onClick={onSettings} aria-haspopup="dialog">계정 설정</button><button type="button" disabled={busy || loggingOut} onClick={onLogout}>로그아웃</button></div></SiteHeader><main>
    <h2>내 투표 목록</h2><Notice error>{sessionError}</Notice><Notice error>{error}</Notice>
    {entering ? <p className="loading" role="status">투표를 열고 있어요…</p> : <>
      <section className="panel"><h2>새 투표 만들기</h2><form onSubmit={create}><fieldset disabled={busy}>
        <label>투표 제목<input name="title" required maxLength={120} value={title} onChange={event => setTitle(event.target.value)}/></label>
        <button type="submit" className="primary" disabled={busy || !title.trim()}>투표 만들기</button>
      </fieldset></form></section>
      <section className="panel" aria-label="만든 투표">{polls === null ? error ? <button type="button" onClick={() => { setError(''); void refresh().catch(failure => { if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionEnded(); else setError((failure as Error).message); }); }}>다시 불러오기</button> : <p role="status">내 투표를 불러오고 있어요…</p>
        : polls.length ? <ul className="member-poll-list">{polls.map(poll => <li key={poll.slug}>
          <a href={'/admin/p/' + encodeURIComponent(poll.slug)}>{poll.title}</a>
          <span className={'badge ' + poll.status}>{statusText[poll.status]}</span>
        </li>)}</ul> : <p className="muted">아직 만든 투표가 없습니다.</p>}</section>
    </>}
  </main></div>;
}
