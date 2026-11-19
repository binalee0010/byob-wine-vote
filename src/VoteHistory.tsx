import { useEffect, useRef, useState } from 'react';
import { api, type Candidate, type VoteHistoryRecord, type VoteHistorySummary } from './api';
import { Notice, PhotoDialog, RankedResultList } from './App';
import { votingMethodInfo } from './format';

const formatDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });

export function VoteHistoryDetail({ record, onBack }: { record: VoteHistoryRecord; onBack: () => void }) {
  const [photo, setPhoto] = useState<Candidate | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="panel vote-history">
    <button type="button" className="back" onClick={onBack}>← 지난 투표 목록</button>
    <h2 ref={heading} tabIndex={-1}>{record.title}</h2>
    <p>{record.activityTitle}</p>
    <p className="muted">시작 {formatDate.format(new Date(record.startedAt))} · 저장 {formatDate.format(new Date(record.savedAt))}</p>
    <p className="muted">{votingMethodInfo[record.votingMethod].label} · 총투표 {record.ballotCount}건</p>
    {record.votingMethod === 'winner' && <p className="muted">한 와인에 1표</p>}
    {record.votingMethod === 'full' && <p className="muted">1위 {record.rows.length}점부터 마지막 순위 1점까지</p>}
    {record.votingMethod === 'custom' && <p className="muted">{record.rankPoints.map((points, place) => `${place + 1}위 ${points.toLocaleString('ko-KR')}점`).join(' · ')}</p>}
    <RankedResultList rows={record.rows} onPhoto={setPhoto} method={record.votingMethod} />
    <PhotoDialog photo={photo} onClose={() => setPhoto(null)} />
  </section>;
}

export default function VoteHistory() {
  const [records, setRecords] = useState<VoteHistorySummary[] | null>(null);
  const [selected, setSelected] = useState<VoteHistorySummary | null>(null);
  const [record, setRecord] = useState<VoteHistoryRecord | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousId = useRef<string | null>(null);

  useEffect(() => {
    if (!selected) (document.getElementById(`history-entry-${previousId.current}`) ?? heading.current)?.focus();
  }, [selected]);

  useEffect(() => {
    if (selected || records) return;
    let active = true;
    void api<{ records: VoteHistorySummary[] }>('/admin/history').then(data => {
      if (!Array.isArray(data.records)) throw new Error('투표 기록을 불러오지 못했습니다.');
      if (active) setRecords(data.records);
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [selected, records, attempt]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    void api<{ record: VoteHistoryRecord }>('/admin/history/' + encodeURIComponent(selected.id)).then(data => {
      if (data.record?.id !== selected.id || !Array.isArray(data.record.rows)) throw new Error('투표 기록을 불러오지 못했습니다.');
      if (active) setRecord(data.record);
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [selected, attempt]);

  function back() { setSelected(null); setRecord(null); setError(''); }
  if (record) return <VoteHistoryDetail record={record} onBack={back} />;
  return <section className="panel vote-history">
    {selected && <button type="button" className="back" onClick={back}>← 지난 투표 목록</button>}
    <h2 ref={heading} tabIndex={-1}>{selected?.title ?? '지난 투표'}</h2>
    {error ? <><Notice error>{error}</Notice><button type="button" onClick={() => { setError(''); setAttempt(value => value + 1); }}>다시 불러오기</button></>
      : selected || !records ? <p role="status">투표 기록을 불러오고 있습니다…</p>
      : records.length === 0 ? <p className="muted">저장된 투표 기록이 없습니다.</p>
      : <ul className="ranked-result-list" role="list">{records.map(row => <li key={row.id}>
        <button id={`history-entry-${row.id}`} type="button" className="history-entry" onClick={() => { previousId.current = row.id; setError(''); setSelected(row); }}>
          <strong>{row.title}</strong>
          <small>{row.activityTitle} · {formatDate.format(new Date(row.savedAt))} 저장 · {row.ballotCount}건</small>
        </button>
      </li>)}</ul>}
  </section>;
}
