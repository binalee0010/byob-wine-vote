import { type MouseEventHandler, type ReactNode } from 'react';


export function SiteHeader({ title, children, onHome }: { title: string; children?: ReactNode; onHome?: MouseEventHandler<HTMLAnchorElement> }) {
  return <header className="site-header">
    <h1>{onHome ? <a className="site-title-link" href="/" onClick={onHome}>{title}</a> : title}</h1>
    {children}
  </header>;
}

export function AdminHeader({ title, participantUrl, pollListUrl, onSettings, onLogout, busy }: { title: string; participantUrl?: string; pollListUrl?: string; onSettings?: () => void; onLogout?: () => void; busy?: boolean }) {
  return <header className="admin-header">
    <h1><a className="admin-site-title" href="/admin">{title}</a></h1>
    {(onSettings || onLogout) && <div className="admin-header-actions">
      {pollListUrl && <a className="header-link" href={pollListUrl}>내 투표 목록</a>}
      {participantUrl && <a className="header-link" href={participantUrl} target="_blank" rel="noopener noreferrer">참가자 화면 보기 ↗</a>}
      {onSettings && <button type="button" disabled={busy} onClick={onSettings} aria-haspopup="dialog">계정 설정</button>}
      {onLogout && <button type="button" disabled={busy} onClick={onLogout}>로그아웃</button>}
    </div>}
  </header>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return children ? <div className={'notice' + (error ? ' error' : '')} role={error ? 'alert' : 'status'}>{children}</div> : null;
}
