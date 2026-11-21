import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import Admin, { PasswordChange } from './Admin';
import { api, ApiError, setMemberCsrfToken, setMemberWorkspaceSlug, type Member, type MemberSession } from './api';
import { siteTitle } from './branding';
import { Notice, SiteHeader } from './SiteChrome';
import MemberPolls from './MemberPolls';

type JoinRequest = { id: string; email: string; status: Member['status']; createdAt: string; reviewedAt: string | null };

export default function MemberPortal({ onStandalone }: { onStandalone?: () => void } = {}) {
  const approvalsIntent = new URLSearchParams(location.search).get('settings') === 'approvals';
  const adminUrl = approvalsIntent ? '/admin?settings=approvals' : '/admin';
  const pollSlug = location.pathname.match(/^\/admin\/p\/([a-z0-9-]+)\/?$/)?.[1] ?? null;
  const loginTarget = pollSlug ? '/admin/p/' + pollSlug + (approvalsIntent ? '?settings=approvals' : '') : adminUrl;
  const [session, setSession] = useState<MemberSession>({ authenticated: false, csrfToken: null, member: null });
  const [signup, setSignup] = useState(false);
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('reset') ?? new URLSearchParams(location.search).get('reset'));
  const [resetting, setResetting] = useState(resetToken !== null);
  const [entering, setEntering] = useState(location.pathname.startsWith('/admin') && !resetting);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [settings, setSettings] = useState(false);
  const submitting = useRef(false);
  const sessionEpoch = useRef(0);
  useLayoutEffect(() => {
    if (resetToken === null) return;
    const url = new URL(location.href);
    url.searchParams.delete('reset');
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (fragment.has('reset')) { fragment.delete('reset'); url.hash = fragment.toString(); }
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }, [resetToken]);
  const applySession = useCallback((next: MemberSession) => {
    if (next.authenticated && next.member?.status === 'approved') {
      if (location.pathname !== '/admin' && !pollSlug) { setEntering(true); location.replace(adminUrl); return; }
      if (pollSlug) setMemberWorkspaceSlug(pollSlug);
    }
    setEntering(false);
    setMemberCsrfToken(next.csrfToken);
    setSession(next);
  }, [adminUrl, pollSlug]);
  const refreshSession = useCallback(async () => {
    const current = ++sessionEpoch.current;
    const next = await api<MemberSession>('/members/session');
    if (current === sessionEpoch.current) applySession(next);
  }, [applySession]);
  useEffect(() => {
    if (resetting) return;
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
      if (!stopped && current === sessionEpoch.current) { setEntering(false); setError((e as Error).message); }
    });
    return () => { stopped = true; };
  }, [applySession, onStandalone, resetting]);
  useEffect(() => { if (session?.member?.status !== 'approved') document.title = siteTitle + ' · ' + (resetting ? '비밀번호 재설정' : signup ? '가입 신청' : '로그인'); }, [session, resetting, signup]);
  useEffect(() => {
    if (approvalsIntent && session.authenticated && session.member?.status === 'approved' && session.member.role === 'owner') setSettings(true);
  }, [approvalsIntent, session]);
  const sessionEnded = useCallback(() => {
    ++sessionEpoch.current;
    applySession({ authenticated: false, csrfToken: null, member: null });
    setSettings(false);
    setMessage('로그인 세션이 종료되었습니다. 다시 로그인해 주세요.');
    document.title = siteTitle + ' · 로그인';
    if (location.pathname !== '/') location.replace('/');
  }, [applySession]);
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    ++sessionEpoch.current;
    submitting.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const next = await api<MemberSession>('/members/' + (signup ? 'signup' : 'login'), 'POST', { email, password });
      if (next.authenticated && next.member?.status === 'approved') { setEntering(true); setPassword(''); location.replace(loginTarget); return; }
      else { applySession(next); setPassword(''); }
    } catch (e) { setEntering(false); setError((e as Error).message); }
    submitting.current = false; setBusy(false);
  }
  async function logout() {
    if (submitting.current) return;
    ++sessionEpoch.current;
    submitting.current = true; setBusy(true); setError('');
    try { await api('/members/session', 'DELETE'); applySession({ authenticated: false, csrfToken: null, member: null }); setSettings(false); setPassword(''); setMessage('로그아웃했습니다.'); document.title = siteTitle + ' · 로그인'; location.replace('/'); }
    catch (e) { setError((e as Error).message); throw e; }
    finally { submitting.current = false; setBusy(false); }
  }
  async function changePassword(currentPassword: string, newPassword: string) {
    await api('/members/password', 'POST', { currentPassword, newPassword });
    sessionEnded();
    setMessage('비밀번호를 변경했습니다. 내 계정의 모든 세션이 종료되었습니다. 새 비밀번호로 로그인해 주세요.');
  }
  const member = session?.authenticated ? session.member : null;
  if (!resetting && member?.status === 'approved') return <>
    {pollSlug ? <Admin member={member} pollSlug={pollSlug} onSettings={() => { setError(''); setSettings(true); }} onLogout={() => { void logout().catch(() => {}); }} loggingOut={busy} sessionError={error} onSessionEnded={sessionEnded}/>
      : <MemberPolls onSettings={() => { setError(''); setSettings(true); }} onLogout={() => { void logout().catch(() => {}); }} loggingOut={busy} sessionError={error} onSessionEnded={sessionEnded}/>}
    {settings && <MemberSettings member={member} busy={busy} error={error} onClose={() => { setSettings(false); setError(''); }} onLogout={logout} onChangePassword={changePassword} onSessionEnded={sessionEnded}/>}
  </>;
  return <div className="participant-shell ballot-shell member-shell"><SiteHeader title={siteTitle}/><main>
    <Notice error>{error}</Notice><Notice>{message}</Notice>
    {entering ? <p className="loading" role="status">로그인을 확인하고 있어요…</p>
      : resetting ? <PasswordReset key={resetToken ?? 'request'} token={resetToken} onBack={() => { setResetting(false); setResetToken(null); setSignup(false); }} onRequestAgain={() => setResetToken(null)} onComplete={() => { setResetting(false); setResetToken(null); setSignup(false); setPassword(''); setMessage('비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.'); }}/>
      : member ? <section className="panel member-status"><h2>{member.status === 'pending' ? '가입 승인 대기 중' : '가입 신청이 승인되지 않았습니다'}</h2><p className="member-email">{member.email}</p><p className="muted">{member.status === 'pending' ? '관리자가 가입을 승인하면 내 투표를 만들고 관리할 수 있습니다.' : '가입 신청에 관해 관리자에게 문의해 주세요.'}</p><div className="row"><button type="button" disabled={busy} onClick={() => { setError(''); void refreshSession().catch(e => setError((e as Error).message)); }}>승인 상태 확인</button><button type="button" disabled={busy} onClick={() => { void logout().catch(() => {}); }}>로그아웃</button></div></section>
      : <section className="panel member-login"><h2>{signup ? '가입 신청' : '로그인'}</h2><form onSubmit={authenticate}><fieldset disabled={busy}>
        <label>이메일<input type="email" name="email" autoFocus autoComplete="username" maxLength={254} required value={email} onChange={e => setEmail(e.target.value)}/></label>
        <label>비밀번호<input type="password" name="password" autoComplete={signup ? 'new-password' : 'current-password'} required value={password} onChange={e => setPassword(e.target.value)}/></label>
        <button className="primary" disabled={busy || !email.trim() || !password}>{busy ? '확인 중…' : signup ? '가입 신청' : '로그인'}</button>
      </fieldset></form><div className="member-login-links"><button type="button" className="text-button" disabled={busy} onClick={() => { setSignup(!signup); setPassword(''); setError(''); setMessage(''); }}>{signup ? '로그인으로 돌아가기' : '가입 신청'}</button><button type="button" className="text-button" disabled={busy} onClick={() => { setResetting(true); setPassword(''); setError(''); setMessage(''); }}>비밀번호 재설정</button></div></section>}
  </main></div>;
}

export function PasswordReset({ token, onBack, onRequestAgain, onComplete }: { token: string | null; onBack: () => void; onRequestAgain: () => void; onComplete: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [invalid, setInvalid] = useState(token === '');
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => { if (sent || invalid) result.current?.focus(); }, [sent, invalid]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || invalid || sent) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      if (token !== null) { await api('/members/password-reset/confirm', 'POST', { token, newPassword: password }); setPassword(''); onComplete(); }
      else { await api('/members/password-reset/request', 'POST', { email }); setSent(true); }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_reset_token') { setPassword(''); setInvalid(true); }
      else setError((e as Error).message);
    } finally { submitting.current = false; setBusy(false); }
  }
  return <section className="panel member-login"><h2>비밀번호 재설정</h2><Notice error>{error}</Notice>
    {invalid ? <div ref={result} tabIndex={-1} className="member-reset-result"><Notice error>재설정 링크가 만료되었거나 이미 사용되었습니다. 새 메일을 요청해 주세요.</Notice><button type="button" className="primary" onClick={onRequestAgain}>새 재설정 메일 받기</button></div>
      : sent ? <div ref={result} tabIndex={-1} className="member-reset-result"><Notice>가입한 이메일이면 재설정 링크를 보냈습니다. 메일이 오지 않으면 다시 요청해 주세요.</Notice><button type="button" onClick={() => setSent(false)}>다시 요청</button></div>
      : <form onSubmit={submit}><fieldset disabled={busy}>
        {token !== null ? <label>새 비밀번호<input type="password" name="newPassword" autoFocus autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)}/></label>
          : <label>이메일<input type="email" name="email" autoFocus autoComplete="username" maxLength={254} required value={email} onChange={e => setEmail(e.target.value)}/></label>}
        <button type="submit" className="primary" disabled={busy || (token !== null ? !password : !email.trim())}>{busy ? '처리 중…' : token !== null ? '비밀번호 변경' : '재설정 메일 보내기'}</button>
      </fieldset></form>}
    <button type="button" className="text-button" disabled={busy} onClick={onBack}>로그인으로 돌아가기</button>
  </section>;
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
    <p className="member-email">{member.email}</p><small>{member.role === 'owner' ? '관리자' : '회원'}</small><Notice error>{error}</Notice>
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
