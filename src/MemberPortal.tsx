import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import Admin, { PasswordChange } from './Admin';
import { api, ApiError, setMemberCsrfToken, setMemberWorkspaceSlug, type Member, type MemberSession } from './api';
import { siteTitle } from './branding';
import { Notice, SiteHeader } from './SiteChrome';

type JoinRequest = { id: string; email: string; status: Member['status']; createdAt: string; reviewedAt: string | null };

export default function MemberPortal({ onStandalone }: { onStandalone?: () => void } = {}) {
  const approvalsIntent = new URLSearchParams(location.search).get('settings') === 'approvals';
  const adminUrl = approvalsIntent ? '/admin?settings=approvals' : '/admin';
  const [session, setSession] = useState<MemberSession>({ authenticated: false, csrfToken: null, member: null });
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [settings, setSettings] = useState(false);
  const submitting = useRef(false);
  const sessionEpoch = useRef(0);
  const applySession = useCallback((next: MemberSession) => {
    if (next.authenticated && next.member?.status === 'approved') {
      if (location.pathname !== '/admin') { location.replace(adminUrl); return; }
      if (next.member.workspaceSlug) setMemberWorkspaceSlug(next.member.workspaceSlug);
    }
    setMemberCsrfToken(next.csrfToken);
    setSession(next);
  }, [adminUrl]);
  const refreshSession = useCallback(async () => {
    const current = ++sessionEpoch.current;
    const next = await api<MemberSession>('/members/session');
    if (current === sessionEpoch.current) applySession(next);
  }, [applySession]);
  useEffect(() => {
    const current = ++sessionEpoch.current;
    let stopped = false;
    void api<MemberSession>('/members/session').then(next => {
      if (!stopped && current === sessionEpoch.current) applySession(next);
    }).catch(async e => {
      if (stopped || current !== sessionEpoch.current) return;
      if (e instanceof ApiError && e.status === 404 && onStandalone) {
        try {
          const mode = await api<{ mode: string; membership?: boolean }>('/mode');
          if (!stopped && current === sessionEpoch.current && mode.mode === 'ranked-byob' && mode.membership !== true) { onStandalone(); return; }
        } catch { /* Keep the login screen when the installation mode cannot be confirmed. */ }
      }
      if (!stopped && current === sessionEpoch.current) setError((e as Error).message);
    });
    return () => { stopped = true; };
  }, [applySession, onStandalone]);
  useEffect(() => { if (session?.member?.status !== 'approved') document.title = siteTitle + ' · 운영자 로그인'; }, [session]);
  useEffect(() => {
    if (approvalsIntent && session.authenticated && session.member?.status === 'approved' && session.member.role === 'owner') setSettings(true);
  }, [approvalsIntent, session]);
  const sessionEnded = useCallback(() => {
    ++sessionEpoch.current;
    applySession({ authenticated: false, csrfToken: null, member: null });
    setSettings(false);
    setMessage('로그인 세션이 종료되었습니다. 다시 로그인해 주세요.');
    document.title = siteTitle + ' · 운영자 로그인';
    if (location.pathname !== '/') location.replace('/');
  }, [applySession]);
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    ++sessionEpoch.current;
    submitting.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const next = await api<MemberSession>('/members/' + (signup ? 'signup' : 'login'), 'POST', { email, password });
      if (next.authenticated && next.member?.status === 'approved') { setPassword(''); location.replace(adminUrl); }
      else { applySession(next); setPassword(''); }
    } catch (e) { setError((e as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function logout() {
    if (submitting.current) return;
    ++sessionEpoch.current;
    submitting.current = true; setBusy(true); setError('');
    try { await api('/members/session', 'DELETE'); applySession({ authenticated: false, csrfToken: null, member: null }); setSettings(false); setPassword(''); setMessage('로그아웃했습니다.'); document.title = siteTitle + ' · 운영자 로그인'; location.replace('/'); }
    catch (e) { setError((e as Error).message); throw e; }
    finally { submitting.current = false; setBusy(false); }
  }
  async function changePassword(currentPassword: string, newPassword: string) {
    await api('/members/password', 'POST', { currentPassword, newPassword });
    sessionEnded();
    setMessage('비밀번호를 변경했습니다. 내 계정의 모든 세션이 종료되었습니다. 새 비밀번호로 로그인해 주세요.');
  }
  const member = session?.authenticated ? session.member : null;
  if (member?.status === 'approved') return <>
    <Admin member={member} onSettings={() => { setError(''); setSettings(true); }} onSessionEnded={sessionEnded}/>
    {settings && <MemberSettings member={member} busy={busy} error={error} onClose={() => { setSettings(false); setError(''); }} onLogout={logout} onChangePassword={changePassword} onSessionEnded={sessionEnded}/>}
  </>;
  return <div className="participant-shell ballot-shell member-shell"><SiteHeader title={siteTitle}/><main>
    <div><h2>투표 운영자</h2><p className="muted">승인된 계정으로 나만의 투표와 참가자, 와인 사진, 지난 기록을 관리합니다.</p></div>
    <Notice error>{error}</Notice><Notice>{message}</Notice>
    {member ? <section className="panel member-status"><h3>{member.status === 'pending' ? '가입 승인 대기 중' : '가입 신청이 승인되지 않았습니다'}</h3><p className="member-email">{member.email}</p><p className="muted">{member.status === 'pending' ? '슈퍼관리자가 가입을 승인하면 내 투표를 만들고 관리할 수 있습니다.' : '가입 신청에 관해 슈퍼관리자에게 문의해 주세요.'}</p><div className="row"><button type="button" disabled={busy} onClick={() => { setError(''); void refreshSession().catch(e => setError((e as Error).message)); }}>승인 상태 확인</button><button type="button" disabled={busy} onClick={() => { void logout().catch(() => {}); }}>로그아웃</button></div></section>
      : <section className="panel member-login"><h3>{signup ? '운영자 가입 신청' : '운영자 로그인'}</h3><form onSubmit={authenticate}><fieldset disabled={busy}>
        <label>이메일<input type="email" name="email" autoComplete="username" maxLength={254} required value={email} onChange={e => setEmail(e.target.value)}/></label>
        <label>비밀번호<input type="password" name="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 10 : undefined} maxLength={1024} required value={password} onChange={e => setPassword(e.target.value)}/></label>
        {signup && <small>비밀번호 10자 이상 · 가입 신청 후 슈퍼관리자의 승인이 필요합니다.</small>}
        <button className="primary" disabled={busy || !email.trim() || !password}>{busy ? '확인 중…' : signup ? '가입 신청' : '로그인'}</button>
      </fieldset></form><button type="button" className="text-button" disabled={busy} onClick={() => { setSignup(!signup); setPassword(''); setError(''); setMessage(''); }}>{signup ? '로그인으로 돌아가기' : '운영자 가입 신청'}</button></section>}
    <p className="muted member-participant-help">투표 참가자는 가입하지 않아도 됩니다. 전달받은 투표 링크에서 이름을 입력해 참여해 주세요.</p>
  </main></div>;
}

export function MemberSettings({ member, busy, error, onClose, onLogout, onChangePassword, onSessionEnded }: {
  member: Member; busy: boolean; error: string; onClose: () => void; onLogout: () => Promise<void>;
  onChangePassword: (current: string, next: string) => Promise<void>; onSessionEnded: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
  return <dialog ref={dialog} className="member-settings-dialog" aria-labelledby={titleId} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <div className="row spread"><h2 id={titleId}>계정 설정</h2><button type="button" disabled={busy} onClick={onClose} aria-label="계정 설정 닫기">닫기</button></div>
    <p className="member-email">{member.email}</p><small>{member.role === 'owner' ? '슈퍼관리자' : '투표 운영자'}</small><Notice error>{error}</Notice>
    {member.role === 'owner' && <MembershipRequests onSessionEnded={onSessionEnded}/>}
    <PasswordChange busy={busy} onChangePassword={onChangePassword}/>
    <button type="button" disabled={busy} onClick={() => { void onLogout().catch(() => {}); }}>로그아웃</button>
  </dialog>;
}

export function MembershipRequests({ onSessionEnded }: { onSessionEnded: () => void }) {
  const [requests, setRequests] = useState<JoinRequest[] | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const refresh = useCallback(async () => {
    const next = await api<{ requests: JoinRequest[] }>('/members/requests');
    setRequests(next.requests);
  }, []);
  useEffect(() => { let stopped = false; void api<{ requests: JoinRequest[] }>('/members/requests').then(next => { if (!stopped) setRequests(next.requests); }).catch(e => { if (!stopped) setError((e as Error).message); }); return () => { stopped = true; }; }, []);
  async function decide(request: JoinRequest, decision: 'approve' | 'reject') {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await api('/members/requests/' + encodeURIComponent(request.id) + '/' + decision, 'POST', {});
      setRequests(current => current?.filter(item => item.id !== request.id) ?? null);
      setMessage(request.email + (decision === 'approve' ? ' 가입을 승인했습니다.' : ' 가입을 거절했습니다.'));
      await refresh();
    } catch (e) { if (e instanceof ApiError && e.status === 401) onSessionEnded(); else setError((e as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  }
  const pending = requests?.filter(request => request.status === 'pending');
  return <section className="panel membership-requests"><div className="row spread"><h3>가입 승인</h3><button type="button" disabled={busy} onClick={() => { setError(''); void refresh().catch(e => setError((e as Error).message)); }}>새로고침</button></div><Notice error>{error}</Notice><Notice>{message}</Notice>
    {!requests ? <p role="status">{error ? '가입 신청을 불러오지 못했습니다.' : '가입 신청을 불러오고 있습니다…'}</p> : !pending?.length ? <p className="muted">승인 대기 중인 가입 신청이 없습니다.</p> : <ul className="member-request-list">{pending.map(request => <li key={request.id}><div><strong>{request.email}</strong><small>신청 {new Date(request.createdAt).toLocaleString('ko-KR')}</small></div><div className="row"><button type="button" className="primary" disabled={busy} aria-label={request.email + ' 가입 승인'} onClick={() => { void decide(request, 'approve'); }}>승인</button><button type="button" disabled={busy} aria-label={request.email + ' 가입 거절'} onClick={() => { void decide(request, 'reject'); }}>거절</button></div></li>)}</ul>}
  </section>;
}
