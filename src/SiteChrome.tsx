import { useEffect, useRef, type FormEvent, type MouseEventHandler, type ReactNode } from 'react';


export function SiteHeader({ title, children, onHome }: { title: string; children?: ReactNode; onHome?: MouseEventHandler<HTMLAnchorElement> }) {
  return <header className="site-header">
    <h1>{onHome ? <a className="site-title-link" href="/" onClick={onHome}>{title}</a> : title}</h1>
    {children}
  </header>;
}

export function AdminHeader({ title, onLogout, busy }: { title: string; onLogout?: () => void; busy?: boolean }) {
  return <header className="admin-header">
    <a className="admin-site-title" href="/admin">{title}<span>관리자</span></a>
    {onLogout && <div className="admin-header-actions">
      <a className="header-link" href="/" target="_blank" rel="noopener noreferrer">참가자 화면 보기 ↗</a>
      <button type="button" disabled={busy} onClick={onLogout}>관리자 로그아웃</button>
    </div>}
  </header>;
}

export function AdminLogin({ password, onChange, onSubmit, busy }: {
  password: string; onChange: (value: string) => void; onSubmit: (event: FormEvent) => void; busy: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return <section className="panel login-panel"><h2>관리자 로그인</h2>
    <form onSubmit={onSubmit}>
      <label>비밀번호<input ref={input} type="password" autoComplete="current-password" maxLength={1024} required value={password} onChange={event => onChange(event.target.value)} /></label>
      <button className="primary" disabled={busy || !password}>{busy ? '확인 중…' : '로그인'}</button>
    </form>
  </section>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return children ? <div className={'notice' + (error ? ' error' : '')} role={error ? 'alert' : 'status'}>{children}</div> : null;
}
