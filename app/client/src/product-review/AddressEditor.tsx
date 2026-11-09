import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, MapPin, Search, ShieldCheck, X } from 'lucide-react';
import { addressBindingFingerprint, HOUSE_CHOICES, type DemoAddress } from './examples';
import type { AddressOption } from '@shared/bot/types';
import { localityMatchesQuery } from '@shared/address-index';
import { addressStreetKey } from '@shared/address-selection';
import { clearScopedDraft, readScopedDraftToken, loadAddressDraft, saveDraft, type AddressDraft, type DraftScope } from './ux-drafts';
import { addressSaveError, catalogCities, cityKeyFor, filterHouses, hasCurrentConsent, houseChoices, optionConsentToken, pageItems, selectedCatalogOption, streetChoices, suggestedHouses, type CatalogStatus, type HouseChoice } from './address-editor-model';
import './address-editor.css';

export interface AddressEditorProps {
  initial?: DemoAddress;
  catalog?: AddressOption[];
  /** Live never falls back to invented cities or buildings. */
  mode?: 'demo' | 'live';
  catalogStatus?: CatalogStatus;
  operatorLabels?: Readonly<Record<string, string>>;
  manualGroupHref?: string;
  onRefreshCatalog?: () => Promise<void>;
  draftScope?: DraftScope;
  /** A real provider selection opens review only; it never grants checkbox consent. */
  reviewSelection?: { optionId: string; bindingRevisionId: string; selectionFingerprint: string };
  saving?: boolean;
  onRetry?: () => Promise<void>;
  retrying?: boolean;
  onClose(): void;
  onSave(address: DemoAddress): void | Promise<void>;
}

/** Only the explicitly requested standalone demo gets these synthetic choices. */
function demoCatalog(): AddressOption[] {
  return ['Вінниця', 'Київ', 'Одеса', 'Харків'].flatMap((locality, cityIndex) => HOUSE_CHOICES.map((literal, index) => {
    const id = `demo-${cityIndex}-${index}`;
    return { id: `${id}:option`, address: { id, label: '', territoryId: `demo-${cityIndex}`, locality, street: 'Тестова', aliases: ['Планова'], house: { number: literal, literal } },
      territoryLabel: 'Демонстраційний каталог', binding: { addressId: id, operatorId: 'demo-operator', namespace: 'demo', targetId: id,
        kind: 'building' as const, revisionId: 'demo-1', status: 'needs_confirmation' as const, verifiedAt: null, effectiveFrom: null, effectiveUntil: null } };
  }));
}
function initialCityKey(key: string | undefined, cities: ReturnType<typeof catalogCities>): string {
  if (!key) return '';
  if (cities.some(city => city.key === key)) return key;
  // Compatibility with an earlier draft key containing the unnormalised locality.
  try {
    const value: unknown = JSON.parse(key);
    if (Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'string')) {
      const matches = cities.filter(city => city.territoryId === value[0] && localityMatchesQuery(city.name, value[1]));
      if (matches.length === 1) return matches[0].key;
    }
  } catch { /* A vanished or incompatible city stays unselected. */ }
  return '';
}
function Pager({ total, page, pages, onPage, noun }: { total: number; page: number; pages: number; onPage(value: number): void; noun: string }) {
  if (pages <= 1) return null;
  return <nav className="pr-address-pager" aria-label={`Сторінки: ${noun}`}>
    <button type="button" className="pr-secondary" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label={`Попередня сторінка: ${noun}`}><ArrowLeft size={15} /></button>
    <span role="status">{page + 1} з {pages} · знайдено {total}</span>
    <button type="button" className="pr-secondary" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)} aria-label={`Наступна сторінка: ${noun}`}><ArrowRight size={15} /></button>
  </nav>;
}

export function AddressEditor(props: AddressEditorProps) {
  const key = JSON.stringify([props.draftScope?.ownerId ?? null, props.draftScope?.sessionId ?? null, props.initial?.id ?? null, props.reviewSelection ?? null]);
  return <ScopedAddressEditor key={key} {...props} />;
}

function ScopedAddressEditor({ initial, catalog, mode = 'live', catalogStatus, operatorLabels, manualGroupHref, onRefreshCatalog, draftScope, reviewSelection, saving = false, onRetry, retrying = false, onClose, onSave }: AddressEditorProps) {
  const scope = useRef(draftScope ? { ...draftScope } : undefined).current;
  const mounted = useRef(true), saveInFlight = useRef(false);
  const [localSaving, setLocalSaving] = useState(false);
  const busy = saving || localSaving;
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const options = useMemo(() => catalog ?? (mode === 'demo' ? demoCatalog() : []), [catalog, mode]);
  const availability = catalogStatus ?? (catalog === undefined && mode === 'live' ? 'unavailable' : 'ready');
  const cities = useMemo(() => catalogCities(options), [options]);
  const initialOptions = options.filter(option => option.id === initial?.optionId);
  const initialOption = initialOptions.length === 1 ? initialOptions[0] : undefined;
  const reviewMatches = options.filter(option => option.id === reviewSelection?.optionId);
  const reviewOption = reviewMatches.length === 1 && reviewMatches[0].binding.revisionId === reviewSelection?.bindingRevisionId && optionConsentToken(reviewMatches[0]) === reviewSelection?.selectionFingerprint ? reviewMatches[0] : undefined;
  const reviewBlocked = Boolean(reviewSelection && !reviewOption);
  const [restored] = useState(() => {
    const draft = scope ? loadAddressDraft(scope) : null;
    return draft?.addressId === (initial?.id || null) ? draft : null;
  });
  const restoredOptions = options.filter(option => option.id === restored?.optionId);
  const restoredOption = restoredOptions.length === 1 ? restoredOptions[0] : undefined;
  const restoredStreetKey = restored?.streetKey || (restoredOption ? addressStreetKey(restoredOption.address) : '');
  const restoredStreetAvailable = Boolean(restoredStreetKey && options.some(option => addressStreetKey(option.address) === restoredStreetKey && cityKeyFor(option) === initialCityKey(restored?.cityKey, cities)));
  const [step, setStep] = useState(reviewOption ? 2 : restored && restored.step > 0 ? restoredStreetAvailable ? restored.step === 2 && !restoredOption ? 1 : restored.step : 0 : 0);
  const [cityKey, setCityKey] = useState(() => reviewOption ? cityKeyFor(reviewOption) : initialCityKey(restored?.cityKey, cities) || (restored ? '' : initialOption ? cityKeyFor(initialOption) : (() => { const matches = cities.filter(city => initial && localityMatchesQuery(city.name, initial.city)); return matches.length === 1 ? matches[0].key : ''; })()));
  const cityRecord = cities.find(item => item.key === cityKey);
  const city = cityRecord?.name || '';
  const [query, setQuery] = useState(reviewOption?.address.street ?? restored?.query ?? initial?.street ?? '');
  const [street, setStreet] = useState(reviewOption?.address.street ?? restored?.street ?? initial?.street ?? '');
  const [streetKey, setStreetKey] = useState(() => reviewOption ? addressStreetKey(reviewOption.address) : restoredStreetAvailable ? restoredStreetKey : initialOption ? addressStreetKey(initialOption.address) : '');
  const [house, setHouse] = useState(reviewOption?.address.house.literal ?? restored?.house ?? initial?.house ?? '');
  const [houseQuery, setHouseQuery] = useState('');
  const [objectQuery, setObjectQuery] = useState('');
  const [label, setLabel] = useState(restored?.label ?? initial?.label ?? '');
  const [optionId, setOptionId] = useState(reviewOption?.id ?? restored?.optionId ?? initial?.optionId ?? '');
  const [bindingRevisionId, setBindingRevisionId] = useState(reviewOption?.binding.revisionId ?? restored?.bindingRevisionId ?? initial?.bindingRevisionId ?? '');
  // A persisted checkbox is never current consent. Review the current option after restore.
  const [confirmationToken, setConfirmationToken] = useState('');
  const [selectionToken, setSelectionToken] = useState(reviewOption ? optionConsentToken(reviewOption) : '');
  const [streetPage, setStreetPage] = useState(0), [housePage, setHousePage] = useState(0), [connectionPage, setConnectionPage] = useState(0);
  const [saveError, setSaveError] = useState(''), [refreshing, setRefreshing] = useState(false);
  const [draftStored, setDraftStored] = useState<boolean | null>(scope ? null : false);
  const baselineFingerprint = useRef(restored?.baselineFingerprint ?? initial?.recordFingerprint ?? '');
  const baselineLabel = useRef(restored?.baselineLabel ?? initial?.label ?? '');
  const changedRemote = Boolean(initial && (initial.recordFingerprint !== baselineFingerprint.current || initial.label !== baselineLabel.current));
  const scopedOption = selectedCatalogOption(options, { optionId, cityKey, streetKey, street, house, bindingRevisionId });
  const currentToken = scopedOption ? optionConsentToken(scopedOption) : '';
  const confirmed = hasCurrentConsent(scopedOption, confirmationToken);
  const selectionChanged = Boolean(selectionToken && currentToken !== selectionToken);
  const bindingBlocked = Boolean(scopedOption && (['ambiguous', 'stale'].includes(scopedOption.binding.status) || !currentToken));
  const catalogReady = availability === 'ready' && options.length > 0;
  const canSave = Boolean(catalogReady && label.trim() && label.trim().length <= 32 && house && confirmed && !changedRemote && !selectionChanged && !reviewBlocked);
  const selectionMissing = Boolean(optionId && !scopedOption);
  const dialog = useRef<HTMLDivElement>(null), stepTitle = useRef<HTMLHeadingElement>(null), errorBox = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose), savingRef = useRef(saving);
  closeRef.current = onClose; savingRef.current = busy || saveInFlight.current;

  // A catalog change invalidates consent immediately in render; this effect clears its UI history.
  useEffect(() => { if (confirmationToken && confirmationToken !== currentToken) setConfirmationToken(''); }, [currentToken, confirmationToken]);
  useEffect(() => {
    if (!scope) { setDraftStored(false); return; }
    const payload: AddressDraft = { addressId: initial?.id || null, baselineFingerprint: baselineFingerprint.current, baselineLabel: baselineLabel.current,
      step, cityKey, query, street, streetKey, house, label, confirmed: false, optionId, bindingRevisionId };
    setDraftStored(saveDraft('address', scope, payload));
  }, [step, cityKey, query, street, streetKey, house, label, optionId, bindingRevisionId, scope?.ownerId, scope?.sessionId]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) closeRef.current();
      if (event.key === 'Tab' && dialog.current) {
        const elements = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary')]
          .filter(element => element.getClientRects().length > 0 && !element.closest('fieldset:disabled'));
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  const previousStep = useRef(step);
  useEffect(() => { if (previousStep.current !== step) { previousStep.current = step; stepTitle.current?.focus(); } }, [step]);
  useEffect(() => { if (saveError) errorBox.current?.focus(); }, [saveError]);

  let streets: ReturnType<typeof streetChoices> = [], houses: ReturnType<typeof houseChoices> = [], visibleHouses: HouseChoice[] = [], suggestions: HouseChoice[] = [], searchInvalid = false;
  try {
    streets = streetChoices(options, cityRecord, query);
    houses = houseChoices(options, cityRecord, streetKey, objectQuery);
    visibleHouses = filterHouses(houses, houseQuery);
    suggestions = suggestedHouses(houses, houseQuery);
  } catch { searchInvalid = true; }
  const streetResults = pageItems(streets, streetPage), houseResults = pageItems(visibleHouses, housePage);
  const houseSelection = houses.find(item => item.options.some(option => option.id === optionId)) || houses.find(item => item.literal === house);
  const connectionResults = pageItems(houseSelection?.options || [], connectionPage);
  const duplicateOptionIds = useMemo(() => { const counts = new Map<string, number>(); for (const option of options) counts.set(option.id, (counts.get(option.id) || 0) + 1); return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id)); }, [options]);
  const connectionDescription = (option: AddressOption) => `${operatorLabels?.[option.binding.operatorId] || option.binding.operatorId}${option.connectionLabel ? ` · ${option.connectionLabel}` : ''}`;
  const connectionDistinct = (option: AddressOption) => (houseSelection?.options || []).filter(item => connectionDescription(item) === connectionDescription(option)).length === 1;

  function clearSelection() { setOptionId(''); setBindingRevisionId(''); setConfirmationToken(''); setSelectionToken(''); setSaveError(''); setConnectionPage(0); }
  function chooseOption(option: AddressOption) { setOptionId(option.id); setBindingRevisionId(option.binding.revisionId); setHouse(option.address.house.literal); setConfirmationToken(''); setSelectionToken(optionConsentToken(option)); setSaveError(''); }
  function chooseHouse(choice: HouseChoice) {
    setHouse(choice.literal); clearSelection();
    if (choice.options.length === 1 && !duplicateOptionIds.has(choice.options[0].id)) chooseOption(choice.options[0]);
  }
  async function refreshCatalog() {
    if (!onRefreshCatalog || refreshing || savingRef.current) return;
    setRefreshing(true); setSaveError(''); setConfirmationToken('');
    try { await onRefreshCatalog(); } catch { if (mounted.current) setSaveError('Каталог поки не вдалося оновити. Чернетка залишилася в цьому вікні. Спробуйте пізніше.'); } finally { if (mounted.current) setRefreshing(false); }
  }
  async function save() {
    if (saveInFlight.current || saving || !canSave || !scopedOption || !mounted.current) return;
    saveInFlight.current = true; savingRef.current = true; setLocalSaving(true); setSaveError('');
    const draftToken = scope ? readScopedDraftToken('address', scope) : null;
    // Pass the exact token explicitly accepted by this user, never regenerate consent for a changed option.
    const acceptedToken = confirmationToken;
    try {
      await onSave({ id: initial?.id || scopedOption.address.id, label: label.trim(), city, street: scopedOption.address.street, house: scopedOption.address.house.literal,
        confirmedInDemo: mode === 'demo', paused: initial?.paused || false, optionId: scopedOption.id,
        bindingRevisionId: scopedOption.binding.revisionId, recordFingerprint: addressBindingFingerprint(scopedOption), selectionFingerprint: acceptedToken });
      if (mounted.current && scope) clearScopedDraft('address', scope, undefined, draftToken);
    } catch (error) { if (mounted.current) setSaveError(addressSaveError(error)); }
    finally { saveInFlight.current = false; if (mounted.current) { savingRef.current = saving; setLocalSaving(false); } }
  }

  function close() { if (mounted.current && !savingRef.current) onClose(); }
  return <div className="pr-modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="pr-modal pr-address-editor" role="dialog" aria-modal="true" aria-labelledby="pr-address-title" ref={dialog} data-testid="review-address-editor" data-mode={mode}>
      <div className="pr-modal-top"><span className="pr-eyebrow">МОЯ АДРЕСА</span><button type="button" disabled={busy} className="pr-icon-button" aria-label="Закрити" onClick={close}><X size={19} /></button></div>
      <h2 id="pr-address-title">{initial ? 'Замінити будинок' : 'Додати адресу'}</h2>
      {mode === 'demo' && <p className="pr-quiet-box" data-testid="address-demo-notice">Демонстрація на тестових адресах. Вона не змінює ваш чинний профіль і не вмикає сповіщення.</p>}
      {changedRemote && <div role="alert" className="pr-status-notice pr-warning">Адресу вже змінили в іншому вікні або боті. Чернетка збережена. Закрийте її та перевірте актуальну адресу перед заміною.</div>}
      {reviewBlocked && <div role="alert" className="pr-status-notice pr-warning">Результат пошуку змінився або більше недоступний. Знайдіть будинок ще раз і перевірте його актуальні відомості.</div>}
      {restored && <p className="pr-field-note">Чернетку відновлено. Перед збереженням ще раз перевірте поточний будинок, оператора й приєднання.</p>}
      {draftStored === false ? <div className="pr-status-notice pr-warning" role="status" data-testid="address-draft-unavailable">Браузер не підтвердив збереження чернетки. Введені дані залишаються лише в цьому вікні. Не закривайте редактор, якщо хочете їх зберегти.</div> : <p className="pr-field-note">{draftStored ? 'Назад і закриття зберігають цей крок. Відкидання чернетки — окрема дія.' : 'Перевіряємо, чи можна зберегти чернетку в цьому браузері…'}</p>}
      <div className="pr-stepper" aria-label={`Крок ${step + 1} з 3`}>{['Знайти', 'Будинок', 'Підтвердити'].map((name, index) => <span key={name} className={index <= step ? 'is-active' : ''} aria-current={index === step ? 'step' : undefined}><b>{index < step ? <Check size={12} /> : index + 1}</b>{name}</span>)}</div>
      {!catalogReady ? <div className="pr-quiet-box" role="status" data-testid="address-catalog-status"><strong>{availability === 'loading' ? 'Завантажуємо каталог адрес…' : availability === 'unavailable' ? 'Каталог адрес зараз недоступний' : 'Адреси ще не завантажені до каталогу'}</strong><p>{availability === 'loading' ? 'Зачекайте, будь ласка. Чернетка залишається на місці.' : 'Це не означає, що вашої адреси немає. Спробуйте оновити каталог або поверніться пізніше.'}</p>{onRefreshCatalog && <button type="button" className="pr-text-button" disabled={refreshing || busy} onClick={() => void refreshCatalog()}>{refreshing ? 'Оновлюємо…' : 'Оновити каталог'}</button>}</div> : <fieldset disabled={busy || refreshing} className="pr-address-fields">
      {step === 0 && <div className="pr-form-stack">
        <h3 ref={stepTitle} tabIndex={-1}>Знайдіть свою вулицю</h3>
        <label>Населений пункт<select aria-label="Населений пункт" value={cityKey} onChange={event => { setCityKey(event.target.value); setQuery(''); setStreet(''); setStreetKey(''); setHouse(''); setHouseQuery(''); setStreetPage(0); setHousePage(0); clearSelection(); }}><option value="">Оберіть місто або село</option>{cities.map(item => <option key={item.key} value={item.key}>{item.name}{item.territoryLabel ? ` · ${item.territoryLabel}` : ''}</option>)}</select></label>
        <label>Вулиця або об’єкт<div className="pr-input-icon"><Search size={17} /><input value={query} maxLength={160} disabled={!cityRecord} onChange={event => { setQuery(event.target.value); setStreet(''); setStreetKey(''); setHouse(''); setStreetPage(0); clearSelection(); }} placeholder="Теперішня назва, попередня назва або об’єкт" aria-describedby="pr-street-help pr-street-results" data-testid="review-street-search" /></div></label>
        <p id="pr-street-help" className="pr-field-note">Можна вказати скорочення, наприклад «вул.». Проспект і вулиця з однаковою назвою залишаються різними адресами.</p>
        <div id="pr-street-results" className="pr-field-note" role="status">{!cityRecord ? 'Спочатку оберіть населений пункт.' : query.trim().length < 2 ? 'Введіть щонайменше дві літери назви.' : searchInvalid ? 'Перевірте назву: приберіть незвичні символи або скоротіть запит.' : `Знайдено вулиць: ${streets.length}.`}</div>
        {cityRecord && query.trim().length >= 2 && !searchInvalid && (streetResults.items.length ? <><div className="pr-address-results" aria-label="Знайдені вулиці">{streetResults.items.map(choice => <button type="button" key={choice.key} className="pr-search-result" onClick={() => { setStreet(choice.name); setStreetKey(choice.key); setObjectQuery(choice.matchedObject ? query : ''); setHouse(''); setHouseQuery(''); setHousePage(0); clearSelection(); setStep(1); }}><MapPin size={19} /><span><strong>{choice.name}</strong><small>{city} · {cityRecord.territoryLabel}</small>{choice.matchedAlias && <small>Попередня назва: {choice.matchedAlias}</small>}{choice.matchedObject && <small>Об’єкт у каталозі: {choice.matchedObject} · будинки: {choice.houseExamples.join(', ')}</small>}{streets.filter(item => item.name === choice.name).length > 1 && !choice.matchedObject && <small>Будинки в цьому записі: {choice.houseExamples.join(', ')}</small>}</span><ArrowRight size={17} /></button>)}</div><Pager {...streetResults} noun="вулиці" onPage={setStreetPage} /></> : <div className="pr-quiet-box">За цим запитом вулицю не знайдено в доступному каталозі. Перевірте населений пункт, скорочення або спробуйте попередню назву. Відсутній результат не означає, що вулиці не існує.</div>)}
        {manualGroupHref && <details className="pr-manual-path"><summary>Не вдалося знайти адресу?</summary><p className="pr-field-note">У боті можна обрати чергу вручну. Вона збережеться як ваш вибір, а не як перевірена адреса будинку. Чернетка тут залишиться.</p><a className="pr-text-button" href={manualGroupHref}>Відкрити бота<ArrowRight size={14} /></a></details>}
      </div>}
      {step === 1 && <div className="pr-form-stack">
        <p className="pr-muted">{city} · {cityRecord?.territoryLabel}, {street}</p><h3 ref={stepTitle} tabIndex={-1}>Оберіть точний будинок</h3>
        {objectQuery && <div className="pr-quiet-box">Показано будинки з об’єктом за запитом «{objectQuery}». Назва об’єкта не визначає оператора чи приєднання.<button type="button" className="pr-text-button" onClick={() => { setObjectQuery(''); setHousePage(0); }}>Показати всі будинки на вулиці</button></div>}
        <label>Номер будинку<div className="pr-input-icon"><Search size={17} /><input value={houseQuery} maxLength={80} onChange={event => { setHouseQuery(event.target.value); setHousePage(0); setHouse(''); clearSelection(); }} placeholder="Номер, літера або корпус" aria-describedby="pr-house-help pr-house-results" data-testid="address-house-search" /></div></label>
        <p id="pr-house-help" className="pr-field-note">Літера, дріб і корпус мають значення. «12», «12А», «12/1» та «12 корпус 1» — окремі варіанти. Пошук лише звужує список; будинок обираєте ви.</p>
        <div id="pr-house-results" role="status" className="pr-field-note">{searchInvalid ? 'Перевірте номер: приберіть незвичні символи або скоротіть запит.' : `Будинків у результатах: ${visibleHouses.length}.`}</div>
        {!searchInvalid && <><div className="pr-house-grid" aria-label="Будинки">{houseResults.items.map(choice => <button type="button" key={choice.key} className={houseSelection?.key === choice.key ? 'is-selected' : ''} aria-pressed={houseSelection?.key === choice.key} onClick={() => chooseHouse(choice)}>{choice.literal}{choice.options.length > 1 && <small>Варіантів приєднання: {choice.options.length}</small>}{choice.options[0].address.placeNames?.length ? <small>{choice.options[0].address.placeNames.join(' · ')}</small> : null}</button>)}</div><Pager {...houseResults} noun="будинки" onPage={setHousePage} />{!houseResults.items.length && <p className="pr-quiet-box">За цим номером немає результату в доступному каталозі. Перевірте літерацію, корпус або спробуйте лише початок номера.</p>}
        {suggestions.length > 0 && <div className="pr-address-suggestions"><p className="pr-field-note">Можливо, ви ввели латинську літеру замість української або навпаки. Це різні записи. Оберіть потрібне написання самі:</p>{pageItems(suggestions, 0).items.map(choice => <button type="button" className="pr-secondary" key={choice.key} onClick={() => { setHouseQuery(choice.literal); setHousePage(0); chooseHouse(choice); }}>Обрати написання «{choice.literal}»</button>)}</div>}
        {houseSelection && houseSelection.options.length > 1 && <section className="pr-address-connections" aria-labelledby="pr-connection-heading"><h3 id="pr-connection-heading">Уточніть оператора й приєднання</h3><p className="pr-field-note">Для цього номера є кілька варіантів. Оберіть свій; перший у списку не вибирається автоматично. Дані можна звірити з рахунком або оператором мережі.</p><div className="pr-address-results">{connectionResults.items.map(option => <button type="button" key={option.id} className={`pr-search-result ${optionId === option.id ? 'is-selected' : ''}`} aria-pressed={optionId === option.id} disabled={!connectionDistinct(option) || duplicateOptionIds.has(option.id)} onClick={() => chooseOption(option)}><span><strong>{option.connectionLabel || 'Приєднання'}</strong><small>Оператор: {operatorLabels?.[option.binding.operatorId] || option.binding.operatorId}</small>{!connectionDistinct(option) && <small>Каталог не містить достатніх відомостей, щоб розрізнити ці приєднання.</small>}</span>{optionId === option.id && <Check size={17} />}</button>)}</div><Pager {...connectionResults} noun="приєднання" onPage={setConnectionPage} /></section>}
        </>}
        {scopedOption && <p className="pr-field-note">Обрано: {scopedOption.address.house.literal} · {connectionDescription(scopedOption)}</p>}
        <div className="pr-inline-message"><ShieldCheck size={20} /><span>Найближчий номер або схоже написання не стають вашою адресою автоматично.</span></div>
      </div>}
      {step === 2 && <div className="pr-form-stack">
        <h3 ref={stepTitle} tabIndex={-1}>Перевірте адресу перед збереженням</h3>
        <div className="pr-address-confirm"><MapPin size={22} /><span><strong>{city} · {cityRecord?.territoryLabel}, {street}, {house}</strong>{scopedOption && <><small>Оператор: {operatorLabels?.[scopedOption.binding.operatorId] || scopedOption.binding.operatorId}</small>{scopedOption.connectionLabel && <small>{scopedOption.connectionLabel}</small>}</>}{scopedOption?.address.placeNames?.length ? <small>Об’єкт: {scopedOption.address.placeNames.join(' · ')}</small> : null}<small>Точна адреса залишається у вашому профілі</small></span></div>
        <label>Мітка адреси<input maxLength={32} placeholder="Дім, Робота…" value={label} onChange={event => setLabel(event.target.value)} /></label>
        <label className="pr-checkbox"><input type="checkbox" checked={confirmed} disabled={!scopedOption || selectionChanged || bindingBlocked} onChange={event => setConfirmationToken(event.target.checked && scopedOption ? optionConsentToken(scopedOption) : '')} /><span>Перевірено: це потрібний будинок, оператор і приєднання.</span></label>
        <div className="pr-quiet-box">{mode === 'demo' ? 'Збереження в цій демонстрації не змінює справжні адреси й сповіщення.' : scopedOption?.binding.status === 'needs_confirmation' ? 'Адресу можна зберегти. Точна прив’язка до графіка ще потребує перевірки; це підтвердження не робить її перевіреною.' : 'Збереження адреси та налаштування сповіщень — окремі дії. Опублікований план не є виміром фактичного живлення.'}</div>
      </div>}
      </fieldset>}
      {(selectionMissing || selectionChanged || bindingBlocked) && <div className="pr-status-notice pr-warning" role="alert"><span>{bindingBlocked ? 'Оператор або приєднання ще не визначені однозначно чи дані застаріли. Звірте їх із оператором мережі.' : 'Відомості про обраний будинок змінилися або більше не доступні. Виберіть його ще раз і перевірте нові дані.'}</span><button type="button" disabled={busy} onClick={() => { clearSelection(); setHouse(''); setStep(0); }}>Повернутися до пошуку</button></div>}
      {saveError && <div className="pr-status-notice pr-warning" role="alert" tabIndex={-1} ref={errorBox}><span>{saveError}</span>{onRetry && <button type="button" disabled={retrying} onClick={() => void onRetry().catch(error => { if (mounted.current) setSaveError(addressSaveError(error)); })}>{retrying ? 'Перевіряємо…' : 'Перевірити результат того самого запиту'}</button>}</div>}
      <div className="pr-modal-actions"><button type="button" disabled={busy} className="pr-secondary" onClick={() => { if (!savingRef.current) { if (step) setStep(step - 1); else close(); } }}><ArrowLeft size={16} />{step ? 'Назад' : 'Скасувати'}</button>{catalogReady && step === 1 && <button type="button" className="pr-primary" disabled={busy || !scopedOption || selectionChanged || bindingBlocked} onClick={() => setStep(2)}>Далі<ArrowRight size={16} /></button>}{catalogReady && step === 2 && <button type="button" className="pr-primary" disabled={!canSave || busy || refreshing} onClick={() => void save()}>{busy ? 'Зберігаємо…' : mode === 'demo' ? 'Зберегти в демонстрації' : 'Зберегти адресу'}<Check size={16} /></button>}</div>
      <button type="button" className="pr-text-button pr-discard-draft" disabled={busy} onClick={() => { if (savingRef.current) return; if (scope) clearScopedDraft('address', scope); close(); }}>Відкинути чернетку</button>
    </div>
  </div>;
}
