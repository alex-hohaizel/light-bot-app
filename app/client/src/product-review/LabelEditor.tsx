import { useEffect, useRef, useState } from 'react';
import { clearDraft, draftText, exactKeys, loadDraft, saveDraft, type DraftScope } from './ux-drafts';

export interface LabelDraft { addressId: string; baselineLabel: string; label: string }
export function parseLabelDraft(input: unknown): LabelDraft {
  const value = exactKeys(input, ['addressId', 'baselineLabel', 'label']);
  return { addressId: draftText(value.addressId), baselineLabel: draftText(value.baselineLabel, 32), label: draftText(value.label, 32) };
}
export function LabelEditor({ addressId, currentLabel, scope, blocked, onClose, onSave, onRetry, retrying=false }: { addressId: string; currentLabel: string; scope: DraftScope; blocked: boolean; onClose(): void; onSave(label: string): Promise<void>; onRetry?:()=>Promise<void>; retrying?:boolean }) {
  const [restored] = useState(() => loadDraft('label', scope, parseLabelDraft));
  const baseline = useRef(restored?.addressId === addressId ? restored.baselineLabel : currentLabel);
  const [label, setLabel] = useState(restored?.addressId === addressId ? restored.label : currentLabel), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const conflict = baseline.current !== currentLabel;
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => { saveDraft('label', scope, { addressId, baselineLabel: baseline.current, label }); }, [addressId, label, scope.ownerId, scope.sessionId]);
  return <div className="pr-modal-scrim"><form className="pr-modal" role="dialog" aria-modal="true" aria-labelledby="pr-label-title" onSubmit={event => { event.preventDefault(); if (blocked || conflict || !label.trim()) return; void onSave(label.trim()).then(() => { clearDraft('label'); onClose(); }).catch(error => setError(error instanceof Error ? error.message : 'Збереження ще не підтверджено.')); }} onKeyDown={event => {
    if (event.key === 'Escape' && !blocked) onClose();
    if (event.key === 'Tab') { const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input,button:not(:disabled)')]; const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}><h2 id="pr-label-title">Мітка адреси</h2><p className="pr-field-note">Змінюється лише назва картки. Повторно обирати будинок не потрібно.</p><label className="pr-form-stack">Нова мітка<input ref={input} aria-label="Нова мітка адреси" maxLength={32} value={label} onChange={event => setLabel(event.target.value)} /></label>
    {conflict && <div role="alert" className="pr-status-notice pr-warning">Мітку вже змінили в іншому вікні або боті: «{currentLabel}». Ваша чернетка збережена. Відкиньте її, щоб почати з актуальної назви.</div>}{error && <p role="alert">{error}</p>}
    {onRetry&&<div className="pr-status-notice pr-warning" role="alert"><span>Збереження мітки ще не підтверджено.</span><button type="button" disabled={retrying} onClick={()=>void onRetry().then(()=>{clearDraft('label');onClose();}).catch(e=>setError(e instanceof Error?e.message:'Результат ще не підтверджено.'))}>Перевірити той самий запит</button></div>}
    <div className="pr-modal-actions"><button type="button" className="pr-secondary" disabled={blocked} onClick={onClose}>Закрити й зберегти чернетку</button><button type="submit" className="pr-primary" disabled={blocked || conflict || !label.trim()}>Зберегти мітку</button></div><button type="button" className="pr-text-button pr-discard-draft" disabled={blocked} onClick={() => { clearDraft('label'); onClose(); }}>Відкинути чернетку мітки</button>
  </form></div>;
}
