import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Notice } from './App';

type SuccessMessage = string | ((result: unknown) => string);
export type Action = (path: string, method: string, body?: unknown, feedback?: { error?: (message: string) => void; success: SuccessMessage }) => Promise<boolean>;

type DestructiveRequest = {
  title: string;
  description: string;
  path: string;
  method: 'POST' | 'DELETE';
  body: unknown;
  success: SuccessMessage;
  phrase?: string;
};

export default function DestructiveAction({ label, request, action, busy, disabled, focusFallback, accessibleLabel }: {
  label: string;
  request: DestructiveRequest;
  action: Action;
  busy: boolean;
  disabled?: boolean;
  focusFallback?: string;
  accessibleLabel?: string;
}) {
  const [confirmation, setConfirmation] = useState<DestructiveRequest | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!confirmation) return;
    const modal = dialog.current;
    modal?.showModal();
    cancel.current?.focus();
    return () => {
      modal?.close();
      if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus();
      else if (focusFallback) document.getElementById(focusFallback)?.focus();
    };
  }, [confirmation, focusFallback]);

  function open() {
    setTyped('');
    setError('');
    setConfirmation(request);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmation || busy || disabled || submitting.current || (confirmation.phrase && typed !== confirmation.phrase)) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      if (await action(confirmation.path, confirmation.method, confirmation.body, { error: setError, success: confirmation.success })) setConfirmation(null);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <>
    <button ref={trigger} type="button" className="danger" aria-label={accessibleLabel} disabled={busy || disabled} onClick={open}>{label}</button>
    {confirmation && <dialog ref={dialog} className="destructive-dialog" aria-labelledby={headingId} aria-describedby={descriptionId} onCancel={event => {
      event.preventDefault();
      if (!submitting.current) setConfirmation(null);
    }}>
      <h2 id={headingId}>{confirmation.title}</h2>
      <p id={descriptionId}>{confirmation.description}</p>
      <form onSubmit={submit}>
        {confirmation.phrase && <label>확인 문구 ‘{confirmation.phrase}’ 입력
          <input value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" maxLength={24} disabled={pending || busy} />
        </label>}
        <Notice error>{error}</Notice>
        <div className="row">
          <button ref={cancel} type="button" disabled={pending} onClick={() => setConfirmation(null)}>취소</button>
          <button className="danger" type="submit" disabled={pending || busy || disabled || (!!confirmation.phrase && typed !== confirmation.phrase)}>{pending ? '처리 중…' : label + ' 확인'}</button>
        </div>
      </form>
    </dialog>}
  </>;
}
