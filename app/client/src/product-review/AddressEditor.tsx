import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, MapPin, Search, ShieldCheck, X } from 'lucide-react';
import { addressBindingFingerprint, HOUSE_CHOICES, streetMatches, type DemoAddress } from './examples';
import type { AddressOption } from '@shared/bot/types';
import { clearDraft, loadAddressDraft, saveDraft, type AddressDraft, type DraftScope } from './ux-drafts';

export function AddressEditor({ initial, catalog, draftScope, saving = false, onRetry, retrying = false, onClose, onSave }: { initial?: DemoAddress; catalog?: AddressOption[]; draftScope?: DraftScope; saving?: boolean; onRetry?: () => Promise<void>; retrying?: boolean; onClose(): void; onSave(address: DemoAddress): void | Promise<void> }) {
  const cities = catalog ? [...new Map(catalog.map(option => [JSON.stringify([option.address.territoryId, option.address.locality]),
    { key: JSON.stringify([option.address.territoryId, option.address.locality]), name: option.address.locality, territoryId: option.address.territoryId, territoryLabel: option.territoryLabel }])).values()] :
    ['Вінниця', 'Київ', 'Одеса', 'Харків'].map(name => ({ key: name, name, territoryId: '', territoryLabel: '' }));
  const initialOption = catalog?.find(option => option.id === initial?.optionId);
  const [restored] = useState(() => {
    const draft = draftScope ? loadAddressDraft(draftScope) : null;
    return draft?.addressId === (initial?.id || null) ? draft : null;
  });
  const [step, setStep] = useState(restored?.step ?? 0);
  const [cityKey, setCityKey] = useState(restored?.cityKey ?? (initialOption ? JSON.stringify([initialOption.address.territoryId, initialOption.address.locality]) : cities.find(item => item.name === initial?.city)?.key || cities[0]?.key || ''));
  const cityRecord = cities.find(item => item.key === cityKey);
  const city = cityRecord?.name || '', territoryId = cityRecord?.territoryId || '';
  const [query, setQuery] = useState(restored?.query ?? initial?.street ?? '');
  const [street, setStreet] = useState(restored?.street ?? initial?.street ?? '');
  const [house, setHouse] = useState(restored?.house ?? initial?.house ?? '');
  const [label, setLabel] = useState(restored?.label ?? initial?.label ?? '');
  const [confirmed, setConfirmed] = useState(restored?.confirmed ?? false);
  const [optionId, setOptionId] = useState(restored?.optionId ?? initial?.optionId ?? '');
  const [bindingRevisionId, setBindingRevisionId] = useState(restored?.bindingRevisionId ?? initial?.bindingRevisionId ?? '');
  const [saveError, setSaveError] = useState('');
  const baselineFingerprint = useRef(restored?.baselineFingerprint ?? initial?.recordFingerprint ?? '');
  const baselineLabel = useRef(restored?.baselineLabel ?? initial?.label ?? '');
  const changedRemote = Boolean(initial && (initial.recordFingerprint !== baselineFingerprint.current || initial.label !== baselineLabel.current));
  useEffect(() => {
    if (!draftScope) return;
    const payload: AddressDraft = { addressId: initial?.id || null, baselineFingerprint: baselineFingerprint.current, baselineLabel: baselineLabel.current,
      step, cityKey, query, street, house, label, confirmed, optionId, bindingRevisionId };
    saveDraft('address', draftScope, payload);
  }, [step, cityKey, query, street, house, label, confirmed, optionId, bindingRevisionId, draftScope?.ownerId, draftScope?.sessionId]);
  const streetOptions = catalog?.filter(option => option.address.territoryId === territoryId && option.address.locality === city && [option.address.street, ...option.address.aliases].some(name => name.toLocaleLowerCase('uk-UA').includes(query.trim().toLocaleLowerCase('uk-UA'))));
  const matchedStreets = streetOptions?.filter((option, index, all) => all.findIndex(other => other.address.street === option.address.street && other.address.territoryId === option.address.territoryId) === index) || [];
  const houseOptions = catalog?.filter(option => option.address.territoryId === territoryId && option.address.locality === city && option.address.street === street) || [];
  const selectedOption = catalog?.find(option => option.id === optionId);
  const scopedOption = selectedOption && selectedOption.address.territoryId === territoryId && selectedOption.address.locality === city && selectedOption.address.street === street && selectedOption.address.house.literal === house && selectedOption.binding.revisionId === bindingRevisionId ? selectedOption : undefined;
  const canSave = Boolean(label.trim() && house && confirmed && !changedRemote && (!catalog || scopedOption));
  async function save() {
    setSaveError('');
    if (!canSave) return;
    try { await onSave({ id: initial?.id || selectedOption?.address.id || `demo-${city}-${house}`, label: label.trim(), city, street, house, confirmedInDemo: true, paused: initial?.paused || false,
      optionId: selectedOption?.id || initial?.optionId, bindingRevisionId: selectedOption?.binding.revisionId || initial?.bindingRevisionId, recordFingerprint: scopedOption ? addressBindingFingerprint(scopedOption) : initial?.recordFingerprint }); clearDraft('address'); }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Збереження ще не підтверджено.'); }
  }
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button,input,select')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
      if (event.key === 'Tab' && dialog.current) {
        const elements = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose, saving]);

  return <div className="pr-modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div className="pr-modal" role="dialog" aria-modal="true" aria-labelledby="pr-address-title" ref={dialog} data-testid="review-address-editor">
      <div className="pr-modal-top"><span className="pr-eyebrow">МОЯ АДРЕСА</span><button disabled={saving} className="pr-icon-button" aria-label="Закрити" onClick={onClose}><X size={19} /></button></div>
      <h2 id="pr-address-title">{initial ? 'Замінити будинок' : 'Додати адресу'}</h2>
      {changedRemote && <div role="alert" className="pr-status-notice pr-warning">Адресу вже змінили в іншому вікні або боті. Чернетка збережена, але не перезапише актуальний будинок. Закрийте її та явно відкиньте, щоб почати з поточних даних.</div>}
      <p className="pr-field-note">Назад і закриття зберігають цей крок. Відкидання чернетки — окрема дія.</p>
      <div className="pr-stepper" aria-label={`Крок ${step + 1} з 3`}>{['Знайти', 'Будинок', 'Підтвердити'].map((name, index) => <span key={name} className={index <= step ? 'is-active' : ''}><b>{index < step ? <Check size={12} /> : index + 1}</b>{name}</span>)}</div>
      {step === 0 && <div className="pr-form-stack">
        <label>Населений пункт<select value={cityKey} disabled={saving} onChange={event => { setCityKey(event.target.value); setQuery(''); setStreet(''); setHouse(''); setOptionId(''); setBindingRevisionId(''); setConfirmed(false); }}>{cities.map(item => <option key={item.key} value={item.key}>{item.name}{item.territoryLabel ? ` · ${item.territoryLabel}` : ''}</option>)}</select></label>
        <label>Вулиця<div className="pr-input-icon"><Search size={17} /><input value={query} onChange={event => { setQuery(event.target.value); setStreet(''); setHouse(''); setOptionId(''); setBindingRevisionId(''); setConfirmed(false); }} placeholder="Наприклад, Тестова або стара назва" data-testid="review-street-search" /></div></label>
        <p className="pr-field-note">{catalog ? 'Той самий вигаданий каталог, що й у боті: «вулиця Нова» або її стара назва «вулиця Стара».' : 'Для цього прикладу доступні назви «Тестова» та «Планова» — колишня назва тієї самої вулиці.'}</p>
        {catalog&&<details className="pr-manual-path"><summary>Не знайшли будинок?</summary><p className="pr-field-note">У боті відкрийте «Допомога» → «Обрати чергу вручну». Такий вибір зберігається як непідтверджена група, а не перевірений будинок. Ваша чернетка тут залишиться.</p><a className="pr-text-button" href="/review/bot">Ручний вибір черги у боті<ArrowRight size={14}/></a></details>}
        {catalog ? query.trim().length >= 2 && matchedStreets.length ? matchedStreets.map(option => <button key={option.id} className="pr-search-result" onClick={() => { setStreet(option.address.street); setHouse(''); setOptionId(''); setBindingRevisionId(''); setConfirmed(false); setStep(1); }}><MapPin size={19} /><span><strong>{option.address.street}</strong><small>{city} · {option.territoryLabel} · {option.address.aliases.join(', ')}</small></span><ArrowRight size={17} /></button>) : query.trim().length >= 2 ? <div className="pr-inline-message"><Search size={18} /><span>Такої вулиці немає у тестовому каталозі. Спробуйте «Нова» або «Стара».</span></div> : <div className="pr-quiet-box">Пошук за попередньою назвою повертає той самий ID вулиці.</div> : streetMatches(query) ? <button className={`pr-search-result ${street ? 'is-selected' : ''}`} onClick={() => { setStreet('Тестова'); setStep(1); }}><MapPin size={19} /><span><strong>вулиця Тестова</strong><small>{city} · колишня назва: Планова</small></span><ArrowRight size={17} /></button> : query.length >= 2 ? <div className="pr-inline-message"><Search size={18} /><span>У цьому прикладі такої вулиці немає.</span></div> : <div className="pr-quiet-box">Назва після перейменування збереже той самий ID адреси.</div>}
      </div>}
      {step === 1 && <div className="pr-form-stack"><p className="pr-muted">{city} · {cityRecord?.territoryLabel}, {street}</p><h3>Оберіть точний будинок</h3><div className="pr-house-grid">{catalog ? houseOptions.map(option => <button key={option.id} className={optionId === option.id ? 'is-selected' : ''} onClick={() => { setOptionId(option.id); setBindingRevisionId(option.binding.revisionId); setHouse(option.address.house.literal); setConfirmed(false); }}>{option.address.house.literal}{option.connectionLabel ? ` · ${option.connectionLabel}` : ''}</button>) : HOUSE_CHOICES.map(value => <button key={value} className={house === value ? 'is-selected' : ''} onClick={() => setHouse(value)}>{value}</button>)}</div><div className="pr-inline-message"><ShieldCheck size={20} /><span><strong>12 і 12А — різні будинки.</strong><br />Корпус, літера та кілька вводів перевіряються окремо. Найближчий номер не обирається автоматично.</span></div></div>}
      {step === 2 && <div className="pr-form-stack"><div className="pr-address-confirm"><MapPin size={22} /><span><strong>{city} · {cityRecord?.territoryLabel}, {street}, {house}</strong><small>Точна адреса лишається у профілі</small></span></div><label>Мітка адреси<input maxLength={32} placeholder="Дім, Робота…" value={label} onChange={event => setLabel(event.target.value)} /></label><label className="pr-checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>Це потрібний будинок. Для кількох вводів потрібна окрема перевірка.</span></label><div className="pr-quiet-box">Прив’язка ОСР у цьому прототипі не перевіряється. Збереження адреси не вмикає справжні сповіщення.</div></div>}
      {saveError && <div className="pr-status-notice pr-warning" role="alert"><span>{saveError}</span>{onRetry && <button disabled={retrying} onClick={() => void onRetry().catch(error => setSaveError(error instanceof Error ? error.message : 'Збереження ще не підтверджено.'))}>Перевірити й повторити той самий запит</button>}</div>}
      <div className="pr-modal-actions"><button disabled={saving} className="pr-secondary" onClick={() => step ? setStep(step - 1) : onClose()}><ArrowLeft size={16} />{step ? 'Назад' : 'Скасувати'}</button>{step === 1 && <button className="pr-primary" disabled={!house || Boolean(catalog && !scopedOption)} onClick={() => setStep(2)}>Далі<ArrowRight size={16} /></button>}{step === 2 && <button className="pr-primary" disabled={!canSave || saving} onClick={() => void save()}>{saving ? 'Зберігаємо…' : catalog ? 'Зберегти адресу' : 'Зберегти у прототипі'}<Check size={16} /></button>}</div>
      <button className="pr-text-button pr-discard-draft" disabled={saving} onClick={() => { clearDraft('address'); onClose(); }}>Відкинути чернетку</button>
    </div>
  </div>;
}
