import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Candidate, type VoteHistoryRecord, type VoteHistorySummary } from './api';
import { Notice, PhotoDialog, RankedResultList } from './App';
import { votingMethodInfo } from './format';
import DestructiveAction, { type Action } from './DestructiveAction';

const formatDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });

export function VoteHistoryDetail({ record, onBack, onSaved, onDeleted }: {
  record: VoteHistoryRecord; onBack: () => void;
  onSaved: (record: VoteHistoryRecord) => void; onDeleted: (id: string) => void;
}) {
  const [photo, setPhoto] = useState<Candidate | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(record.title);
  const [names, setNames] = useState(record.rows.map(({ id, name }) => ({ id, name })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [conflict, setConflict] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const wasEditing = useRef(false);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (editing) titleInput.current?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const path = '/admin/history/' + encodeURIComponent(record.id);
  const changedNames = names.filter(row => row.name !== record.rows.find(wine => wine.id === row.id)?.name);
  const dirty = title !== record.title || changedNames.length > 0;
  function resetDraft(next = record) {
    setTitle(next.title); setNames(next.rows.map(({ id, name }) => ({ id, name })));
  }
  function report(failure: unknown) {
    const changed = failure instanceof ApiError && failure.code === 'history_changed';
    setConflict(changed);
    const message = changed ? '다른 화면에서 기록이 바뀌었습니다. 최신 기록을 불러온 뒤 다시 수정해 주세요.' : (failure as Error).message;
    setError(message);
    return message;
  }
  async function save(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (submitting.current || !dirty || !title.trim() || names.some(row => !row.name.trim())) return;
    submitting.current = true; setBusy(true); setError(''); setFeedback('');
    try {
      const { record: next } = await api<{ record: VoteHistoryRecord }>(path, 'PUT', { expectedVersion: record.version, title, names: changedNames });
      onSaved(next); resetDraft(next); setEditing(false); setConflict(false); setFeedback('투표 기록을 저장했습니다.');
    } catch (failure) { report(failure); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function reload() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(''); setFeedback('');
    try {
      const { record: next } = await api<{ record: VoteHistoryRecord }>(path);
      onSaved(next); resetDraft(next); setConflict(false); setFeedback('최신 기록을 불러왔습니다.');
    } catch (failure) { report(failure); }
    finally { submitting.current = false; setBusy(false); }
  }
  const remove: Action = async (deletePath, method, body, result) => {
    if (submitting.current) return false;
    submitting.current = true; setBusy(true); setError(''); setFeedback('');
    try {
      await api(deletePath, method, body);
      onDeleted(record.id);
      return true;
    } catch (failure) { result?.error?.(report(failure)); return false; }
    finally { submitting.current = false; setBusy(false); }
  };
  return <section className="panel vote-history">
    <button type="button" className="back" disabled={busy} onClick={onBack}>← 지난 투표 목록</button>
    <h2 ref={heading} tabIndex={-1}>{record.title}</h2>
    <p>{record.activityTitle}</p>
    <p className="muted">시작 {formatDate.format(new Date(record.startedAt))} · 저장 {formatDate.format(new Date(record.savedAt))}</p>
    <p className="muted">{votingMethodInfo[record.votingMethod].label} · 총투표 {record.ballotCount}건</p>
    {record.votingMethod === 'winner' && <p className="muted">한 와인에 1표</p>}
    {record.votingMethod === 'full' && <p className="muted">1위 {record.rows.length}점부터 마지막 순위 1점까지</p>}
    {record.votingMethod === 'custom' && <p className="muted">{record.rankPoints.map((points, place) => `${place + 1}위 ${points.toLocaleString('ko-KR')}점`).join(' · ')}</p>}
    <Notice error>{error}</Notice><Notice>{feedback}</Notice>
    {conflict && <div className="history-conflict"><p className="muted">최신 기록을 불러오면 작성 중인 변경사항을 버립니다.</p>
      <button type="button" disabled={busy} onClick={() => void reload()}>최신 기록 불러오기</button></div>}
    <div className="row history-actions">
      <button ref={editButton} type="button" disabled={busy || editing} onClick={() => { resetDraft(); setEditing(true); setError(''); setFeedback(''); }}>기록 수정</button>
      <DestructiveAction label="기록 삭제" busy={busy} disabled={editing} action={remove} request={{
        title: '저장된 투표 기록 삭제', description: `‘${record.title}’ 기록을 삭제합니다. 삭제한 기록은 되돌릴 수 없습니다.`,
        path, method: 'DELETE', body: { expectedVersion: record.version, confirm: 'delete-history' }, success: '투표 기록을 삭제했습니다.',
      }} />
    </div>
    {editing && <form className="history-edit-form" onSubmit={event => void save(event)}>
      <label>모임명<input ref={titleInput} value={title} maxLength={160} required disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      <div className="field-grid">{names.map((wine, index) => <label key={wine.id}>와인 {record.rows[index].number} 이름
        <input value={wine.name} maxLength={160} required disabled={busy} onChange={event => setNames(current => current.map(row => row.id === wine.id ? { ...row, name: event.target.value } : row))} />
      </label>)}</div>
      <div className="row"><button type="submit" className="primary" disabled={busy || !dirty || !title.trim() || names.some(wine => !wine.name.trim())}>{busy ? '저장 중…' : '변경사항 저장'}</button>
        <button type="button" disabled={busy} onClick={() => { resetDraft(); setEditing(false); setError(''); }}>수정 취소</button></div>
    </form>}
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
  function saved(next: VoteHistoryRecord) {
    setRecord(next);
    setRecords(current => current?.map(row => row.id === next.id ? next : row) ?? null);
  }
  function deleted(id: string) {
    setRecords(current => current?.filter(row => row.id !== id) ?? null);
    back();
  }
  if (record) return <VoteHistoryDetail key={record.id} record={record} onBack={back} onSaved={saved} onDeleted={deleted} />;
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
