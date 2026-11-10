import { useEffect, useRef, useState } from 'react';
import {DurationField} from './DurationField';
import {durationLabel} from './schedule-model';
import type { BotProfile } from '@shared/bot/types';
import type { ProfileMutation } from '@shared/profile-mutation';
import { defaultNotificationPolicy, parseLocationNotificationPolicy, parseNotificationPolicy,
  type ChannelNotificationPolicy, type LocationNotificationPolicy, type NotificationChannel, type NotificationPolicy } from '@shared/notification-policy';

import { clearDraft, loadDraft, saveDraft } from './ux-drafts';
import { readNotificationForm as readForm, readNotificationLocations as readLocations, sameDraftValue as same,
  parseNotificationDraft, type NotificationForm as Form } from './notification-draft';
import './notification-policy.css';
const CHANNEL_NAMES = { telegram: 'Telegram', push: 'Push у застосунку' };
interface EditorProps {
  profile: BotProfile; revision: number; sessionId: string; blocked: boolean; lastMutationId: string; focusAddressId?: string;
  mutate(value: ProfileMutation): Promise<unknown>;
}

function Toggle({ title, checked, onChange }: { title: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="pr-switch-row"><span><strong>{title}</strong></span><input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}
function GlobalChannel({ name, value, onChange }: { name: NotificationChannel; value: ChannelNotificationPolicy; onChange(value: ChannelNotificationPolicy): void }) {
  return <div className="pr-policy-channel" data-testid={`policy-global-${name}`}>
    <h3>{CHANNEL_NAMES[name]}</h3>
    <Toggle title={`Дозволяти ${name === 'telegram' ? 'повідомлення у Telegram' : 'push у застосунку'}`} checked={value.enabled} onChange={enabled => onChange({ ...value, enabled })} />
    <Toggle title={`Нагадування · ${CHANNEL_NAMES[name]}`} checked={value.remindersEnabled} onChange={remindersEnabled => onChange({ ...value, remindersEnabled })} />
    <div className="pr-policy-fields"><DurationField label={`${CHANNEL_NAMES[name]} · перед вимкненням`} value={value.beforeOffMinutes} onChange={n=>onChange({...value,beforeOffMinutes:n??0})}/><DurationField label={`${CHANNEL_NAMES[name]} · перед відновленням`} value={value.beforeOnMinutes} onChange={n=>onChange({...value,beforeOnMinutes:n??0})}/></div>
    <p className="pr-field-note">0 вимикає лише відповідне нагадування. Згода на інший канал не змінюється.</p>
  </div>;
}

export function NotificationPolicyEditor(props: EditorProps) {
  try { readForm(props.profile); readLocations(props.profile); }
  catch { return <section className="pr-panel"><h2>Налаштування потребують перевірки</h2><p>Попередні значення збережені. Оновіть профіль, щоб отримати перевірені налаштування.</p></section>; }
  return <NotificationPolicyForm {...props} />;
}
function NotificationPolicyForm({ profile, revision, sessionId, blocked, mutate, focusAddressId }: EditorProps) {
  const scope = { ownerId: profile.id, sessionId };
  const [restored] = useState(() => loadDraft('notifications', scope, parseNotificationDraft));
  const [form, setForm] = useState<Form>(() => restored?.form || readForm(profile));
  const [locations, setLocations] = useState(() => restored?.locations || readLocations(profile));
  const [dirty, setDirty] = useState(() => Boolean(restored && !same(restored.form, restored.baselineForm))), [dirtyLocations, setDirtyLocations] = useState<string[]>(() => restored ? Object.keys(restored.locations).filter(id => !same(restored.locations[id], restored.baselineLocations[id])) : []);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false), [localConflicts, setLocalConflicts] = useState<string[]>([]);
  const baseline = useRef({ form: restored?.baselineForm || readForm(profile), locations: restored?.baselineLocations || readLocations(profile), revision: restored?.baselineRevision ?? revision });
  const [area, setArea] = useState<'summary' | 'channel' | 'address' | 'advanced'>(focusAddressId?'address':'summary');
  const [channel, setChannel] = useState<NotificationChannel>('telegram');
  const [addressId, setAddressId] = useState(focusAddressId||profile.primaryAddressId || profile.locations[0]?.address.id || '');
  useEffect(()=>{if(focusAddressId&&profile.locations.some(l=>l.address.id===focusAddressId)){setAddressId(focusAddressId);setArea('address');}},[focusAddressId]);
  const previousSession = useRef(`${profile.id}:${sessionId}`);
  useEffect(() => {
    const changedSession = previousSession.current !== `${profile.id}:${sessionId}`;
    previousSession.current = `${profile.id}:${sessionId}`;
    if (changedSession) { clearDraft('notifications'); setArea('summary'); baseline.current.revision = revision; }
    const remote = readForm(profile), remoteLocations = readLocations(profile);
    if (changedSession || !dirty || same(remote, form)) { setForm(remote); setDirty(false); setConflict(false); baseline.current.form = remote; }
    else if (!same(remote, baseline.current.form)) setConflict(true);
    const remaining = changedSession ? [] : dirtyLocations.filter(id => remoteLocations[id] && !same(remoteLocations[id], locations[id]));
    setLocalConflicts(remaining.filter(id => !same(remoteLocations[id], baseline.current.locations[id])));
    setLocations(Object.fromEntries(Object.entries(remoteLocations).map(([id, value]) => [id, remaining.includes(id) ? locations[id] : value])));
    baseline.current.locations = Object.fromEntries(Object.entries(remoteLocations).map(([id, value]) => [id, remaining.includes(id) ? baseline.current.locations[id] : value]));
    setDirtyLocations(remaining);
    if (!dirty && !remaining.length) baseline.current.revision = revision;
    setAddressId(current => profile.locations.some(location => location.address.id === current) ? current : profile.primaryAddressId || profile.locations[0]?.address.id || '');
  }, [revision, sessionId, profile.id]);
  useEffect(() => {
    if (previousSession.current !== `${profile.id}:${sessionId}`) return;
    if (!dirty && !dirtyLocations.length) { clearDraft('notifications'); return; }
    saveDraft('notifications', scope, { form, locations, baselineForm: baseline.current.form, baselineLocations: baseline.current.locations, baselineRevision: baseline.current.revision });
  }, [form, locations, dirty, dirtyLocations, revision, sessionId, profile.id]);
  function reloadGlobal() { const remote = readForm(profile); baseline.current.form = remote; baseline.current.revision = revision; setForm(remote); setDirty(false); setConflict(false); setError(''); }
  function reloadLocation(id: string) {
    const remote = readLocations(profile)[id]; baseline.current.locations[id] = remote;
    setLocations(current => ({ ...current, [id]: remote })); setDirtyLocations(current => current.filter(value => value !== id));
    setLocalConflicts(current => current.filter(value => value !== id)); setError('');
  }
  function update(change: Partial<Form>) { setForm(value => ({ ...value, ...change })); setDirty(true); setNotice(''); }
  function localChange(id: string, channel: NotificationChannel, value: LocationNotificationPolicy['channels'][NotificationChannel]) {
    setLocations(current => ({ ...current, [id]: { ...current[id], channels: { ...current[id].channels, [channel]: value } } }));
    setDirtyLocations(current => [...new Set([...current, id])]); setNotice('');
  }
  async function save() {
    setError('');
    try {
      if (conflict || !same(readForm(profile), baseline.current.form)) throw new Error('Налаштування вже змінилися в іншому вікні або боті. Завантажте актуальні значення.');
      const policy = parseNotificationPolicy(form.policy);
      if (form.quiet.enabled && form.quiet.start === form.quiet.end) throw new Error('Для тихих годин оберіть різні початок і кінець.');
      if (!Number.isInteger(form.minimum) || form.minimum < 0 || form.minimum > 86400) throw new Error('Перевірте мінімальну тривалість у хвилинах.');
      await mutate({ kind: 'preferences', patch: { notificationPolicy: policy, paused: form.paused,
        quietHours: form.quiet, morningBriefing: form.briefing, minimumOutageMinutes: form.minimum } });
      setDirty(false);
      setNotice('Налаштування сповіщень збережено.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Збереження ще не підтверджено.'); }
  }
  async function saveLocation(id: string) {
    setError('');
    try {
      if (localConflicts.includes(id) || !same(readLocations(profile)[id], baseline.current.locations[id])) throw new Error('Налаштування адреси вже змінилися. Завантажте актуальні значення.');
      await mutate({ kind: 'location', addressId: id, notificationPolicy: parseLocationNotificationPolicy(locations[id]) }); setDirtyLocations(current => current.filter(value => value !== id));
      setNotice('Налаштування сповіщень для цієї адреси збережено.');
    }
    catch (error) { setError(error instanceof Error ? error.message : 'Збереження ще не підтверджено.'); }
  }
  const selectedLocation = profile.locations.find(location => location.address.id === addressId);
  const selectedPolicy = selectedLocation && locations[selectedLocation.address.id];
  const lead = (minutes: number) => minutes === 0 ? 'вимкнено' : 'за '+durationLabel(minutes);
  const channelSummary = (value: ChannelNotificationPolicy) => `${value.enabled ? 'Дозволено' : 'Згоду вимкнено'} · нагадування ${value.remindersEnabled ? 'увімкнені' : 'вимкнені'} · перед вимкненням ${lead(value.beforeOffMinutes)} · перед відновленням ${lead(value.beforeOnMinutes)}`;
  return <section className="pr-notification-policy" data-testid="notification-policy-editor">
    <div className="pr-section-intro"><div><h2>Сповіщення у вашому ритмі.</h2><p>Спочатку оберіть канал або адресу. Сповіщення надходитимуть за адресами, для яких підтверджено графік.</p></div></div>
    {error && <div role="alert" className="pr-status-notice pr-warning">{error}</div>}
    {notice && <p role="status" className="pr-field-note">{notice}</p>}
    {(dirty || dirtyLocations.length > 0) && <div className="pr-draft-banner" role="status"><span>Є незбережені зміни. Збережіть їх, щоб застосувати налаштування.</span><button className="pr-text-button" onClick={() => { reloadGlobal(); for (const id of dirtyLocations) reloadLocation(id); clearDraft('notifications'); }}>Відкинути чернетку сповіщень</button></div>}
    <nav className="pr-policy-navigation" aria-label="Групи сповіщень">
      <button type="button" aria-pressed={area === 'summary'} className={area === 'summary' ? 'is-active' : ''} onClick={() => setArea('summary')}>Огляд</button>
      <button type="button" aria-pressed={area === 'channel'} className={area === 'channel' ? 'is-active' : ''} onClick={() => setArea('channel')}>Канали</button>
      <button type="button" aria-pressed={area === 'address'} className={area === 'address' ? 'is-active' : ''} onClick={() => setArea('address')}>Для адреси</button>
      <button type="button" aria-pressed={area === 'advanced'} className={area === 'advanced' ? 'is-active' : ''} onClick={() => setArea('advanced')}>Тиша й додаткове</button>
    </nav>
    {area === 'summary' && <div className="pr-policy-summary">
      {(['telegram', 'push'] as const).map(name => <button key={name} className="pr-panel pr-summary-card" onClick={() => { setChannel(name); setArea('channel'); }}><strong>{CHANNEL_NAMES[name]}</strong><span>{channelSummary(form.policy.channels[name])}</span><small>Змінити цей канал</small></button>)}
      <button className="pr-panel pr-summary-card" onClick={() => setArea('address')}><strong>Окремі адреси</strong><span>{profile.locations.length} адрес · власна згода й час або «Як у каналі»</span><small>Обрати адресу</small></button>
      <button className="pr-panel pr-summary-card" onClick={() => setArea('advanced')}><strong>{form.paused ? 'Усі повідомлення на паузі' : 'Тиша й додаткове'}</strong><span>{form.quiet.enabled ? `Тиша ${form.quiet.start}–${form.quiet.end}` : 'Тихі години вимкнені'} · {form.briefing.enabled ? `огляд о ${form.briefing.time}` : 'огляд вимкнений'} · мінімум {durationLabel(form.minimum)}</span><small>Europe/Kyiv · переглянути</small></button>
    </div>}
    {conflict && <div role="alert" className="pr-status-notice pr-warning">Налаштування змінилися в іншому вікні або боті. Чернетку збережено; збереження заблоковано, щоб не перезаписати нові значення. <button onClick={reloadGlobal}>Завантажити актуальні налаштування</button></div>}
    {(area === 'channel' || area === 'advanced') && <fieldset disabled={blocked} className="pr-panel pr-settings-panel">
      {area === 'channel' ? <><div className="pr-segmented" role="group" aria-label="Канал сповіщень">{(['telegram', 'push'] as const).map(name => <button key={name} type="button" aria-pressed={channel === name} className={channel === name ? 'is-active' : ''} onClick={() => setChannel(name)}>{CHANNEL_NAMES[name]}</button>)}</div>
        <GlobalChannel name={channel} value={form.policy.channels[channel]} onChange={value => update({ policy: { ...form.policy, channels: { ...form.policy.channels, [channel]: value } } })} />
        <p className="pr-policy-effective">Підсумок: {channelSummary(form.policy.channels[channel])}.</p></> : <>
        <h3>Тиша, пауза й ранковий огляд</h3>
        <Toggle title="Призупинити всі повідомлення" checked={form.paused} onChange={paused => update({ paused })} />
        <p className="pr-field-note">Пауза зберігає згоду й час. Відновлення не розсилає пропущені повідомлення.</p>
        <details open={form.quiet.enabled}><summary>Тихі години · {form.quiet.enabled ? `${form.quiet.start}–${form.quiet.end}` : 'вимкнені'}</summary>
          <Toggle title="Тихі години" checked={form.quiet.enabled} onChange={enabled => update({ quiet: { ...form.quiet, enabled } })} />
          <div className="pr-time-range"><label>З<input type="time" aria-label="Початок тихих годин" value={form.quiet.start} onChange={event => update({ quiet: { ...form.quiet, start: event.target.value } })} /></label><span>—</span><label>До<input type="time" aria-label="Кінець тихих годин" value={form.quiet.end} onChange={event => update({ quiet: { ...form.quiet, end: event.target.value } })} /></label></div>
          <p className="pr-field-note">Europe/Kyiv, включно з переходом через північ. Тиша діє і для аварійних повідомлень.</p>
        </details>
        <details><summary>Ранковий огляд · {form.briefing.enabled ? form.briefing.time : 'вимкнений'}</summary>
          <Toggle title="Ранковий огляд у Telegram" checked={form.briefing.enabled} onChange={enabled => update({ briefing: { ...form.briefing, enabled } })} />
          <label className="pr-inline-field">Час огляду<input type="time" aria-label="Час ранкового огляду" value={form.briefing.time} onChange={event => update({ briefing: { ...form.briefing, time: event.target.value } })} /></label>
          <p className="pr-field-note">Telegram · Europe/Kyiv · адреси з дозволеним Telegram, крім призупинених. Огляд також залежить від загальної згоди й тиші.</p>
        </details>
        <details><summary>Мінімальна тривалість · {durationLabel(form.minimum)}</summary>
          <DurationField label="Мінімальна тривалість відключення" value={form.minimum} max={86400} zeroLabel="Без фільтра тривалості" onChange={n=>update({minimum:n??0})}/>
          <p className="pr-field-note">Фільтр діє перед вимкненням. Нагадування про планове відновлення він не блокує. 0 — без фільтра.</p>
        </details>
      </>}
      <button className="pr-primary" disabled={!dirty || blocked || conflict} onClick={() => void save()}>Зберегти сповіщення</button>
    </fieldset>}
    {area === 'address' && <div className="pr-panel pr-settings-panel">
      <label className="pr-context-picker">Адреса<select value={addressId} onChange={event => setAddressId(event.target.value)}>{profile.locations.map(location => <option value={location.address.id} key={location.address.id}>{location.address.label}</option>)}</select></label>
      {!selectedLocation || !selectedPolicy ? <p>Спочатку додайте адресу.</p> : <fieldset disabled={blocked} data-testid={`policy-location-${selectedLocation.address.id}`}>
        <h3>{selectedLocation.address.label}{selectedLocation.paused ? ' · адреса на паузі' : ''}</h3>
        <p className="pr-field-note">Адресна згода не вмикає загальну згоду каналу. Час не змінює згоду. Прив’язка будинку перевіряється окремо.</p>
        {localConflicts.includes(addressId) && <div role="alert" className="pr-status-notice pr-warning">Налаштування адреси змінилися. Чернетка не перезапише нові значення. <button onClick={() => reloadLocation(addressId)}>Завантажити актуальні значення адреси</button></div>}
        <div className="pr-segmented" role="group" aria-label="Канал для адреси">{(['telegram', 'push'] as const).map(name => <button key={name} type="button" aria-pressed={channel === name} className={channel === name ? 'is-active' : ''} onClick={() => setChannel(name)}>{CHANNEL_NAMES[name]}</button>)}</div>
        <div className="pr-policy-channel"><Toggle title={`${CHANNEL_NAMES[channel]} · ${selectedLocation.address.label}`} checked={selectedPolicy.channels[channel].enabled} onChange={enabled => localChange(addressId, channel, { ...selectedPolicy.channels[channel], enabled })} />
          <div className="pr-policy-fields">{(['beforeOffMinutes','beforeOnMinutes'] as const).map(field=><DurationField key={field} label={`${selectedLocation.address.label} · ${CHANNEL_NAMES[channel]} · ${field==='beforeOffMinutes'?'перед вимкненням':'перед відновленням'}`} value={selectedPolicy.channels[channel][field]} allowInherit inheritValue={form.policy.channels[channel][field]} onChange={n=>{const next={...selectedPolicy.channels[channel]};if(n===undefined)delete next[field];else next[field]=n;localChange(addressId,channel,next);}}/>)}</div>
          <p className="pr-field-note">Оберіть «Як у каналі» для загального часу. 0 год 0 хв вимикає лише цей тип нагадування.</p>
          <p className="pr-policy-effective">Ефективно: {form.paused || selectedLocation.paused ? 'на паузі' : form.policy.channels[channel].enabled && selectedPolicy.channels[channel].enabled ? 'канал і адреса дозволені' : 'потрібна згода каналу й адреси'} · перед вимкненням {lead(selectedPolicy.channels[channel].beforeOffMinutes ?? form.policy.channels[channel].beforeOffMinutes)} · перед відновленням {lead(selectedPolicy.channels[channel].beforeOnMinutes ?? form.policy.channels[channel].beforeOnMinutes)}.</p>
        </div>
        <button className="pr-primary" disabled={blocked || localConflicts.includes(addressId) || !dirtyLocations.includes(addressId)} onClick={() => void saveLocation(addressId)}>Зберегти для «{selectedLocation.address.label}»</button>
      </fieldset>}
    </div>}
  </section>;
}
