import { useEffect, useRef, useState } from 'react';
import type { BotInput, BotMessage, BotState } from '@shared/bot/types';
import { PLAN_STATUS_COPY, type PlanStatus, type ScheduleView } from '@shared/product-contract';
import {useViewPreferences} from '../product-review/view-preferences';
import { ScheduleCard } from '../product-review/schedule-renderer';
import '../product-review/product-review.css';
import './bot-review.css';

type StoredMessage = BotMessage & { schedule?: ScheduleView };
type Snapshot = { state: BotState | null; messages: StoredMessage[]; receipt?: { id: string; sessionRevision: number; committed: boolean }; replayed?: boolean };
type Pending = { input: BotInput; status: PlanStatus };
const commands = ['/start', '/schedule', '/addresses', '/add', '/settings', '/pause', '/resume', '/help'];

async function request(path = '', body?: unknown): Promise<Snapshot> {
  const response = await fetch(`/api/review/bot${path}`, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Не вдалося отримати відповідь.');
  return value;
}
export default function BotReview() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ state: null, messages: [] });
  const [text, setText] = useState('');
  const [status, setStatus] = useState<PlanStatus>('published');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const {prefs,update}=useViewPreferences(snapshot.state?.profile.id||'bot-review');const dark=prefs.theme==='dark';
  const [textOnly,setTextOnly]=useState<Record<string,boolean>>({});
  const [clock, setClock] = useState(Date.now());
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { let active = true; request().then(value => { if (active) setSnapshot(value); }).catch(error => { if (active) setError(error.message); }); return () => { active = false; }; }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest', behavior: prefs.motion&&!matchMedia('(prefers-reduced-motion:reduce)').matches?'smooth':'auto' }); }, [snapshot.messages.length]);
  async function send(input: BotInput, fixedStatus = status) {
    if (busy) return;
    const action = { input, status: fixedStatus };
    setBusy(true); setError(''); setPending(action);
    try { setSnapshot(await request('', action)); setPending(null); setText(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Відповідь не отримано.'); }
    finally { setBusy(false); }
  }
  async function reset(mode: 'new' | 'returning') {
    if (busy || pending) return;
    setBusy(true); setError('');
    try { setSnapshot(await request('/reset', { mode })); }
    catch (error) { setError(error instanceof Error ? error.message : 'Спробуйте ще раз.'); }
    finally { setBusy(false); }
  }
  const command = (text: string) => send({ id: crypto.randomUUID(), kind: 'command', text });
  const profile = snapshot.state?.profile;
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 15000); return () => window.clearInterval(timer); }, []);
  const latest = snapshot.messages.at(-1);
  const activeButtons = latest?.buttons.filter(button => {
    const record = snapshot.state?.callbacks[button.callbackId];
    return record && !record.consumed && record.stateRevision === snapshot.state?.revision && Date.parse(record.expiresAt) > clock;
  }) || [];
  const renderMessage = (message: StoredMessage) => <article className="br-message" key={message.id}>
    {message.schedule&&!textOnly[message.id]?<ScheduleCard view={message.schedule} theme={dark?'dark':'light'} showText={false}/>:<p>{message.text}</p>}{message.schedule&&<button className="br-text-toggle" onClick={()=>setTextOnly(current=>({...current,[message.id]:!current[message.id]}))}>{textOnly[message.id]?'Показати картку':'Повний текст замість картки'}</button>}
  </article>;
  return <main className={`br-root ${dark ? 'br-dark' : ''}`} data-motion={prefs.motion?'on':'off'}>
    <header className="br-header"><a href="/review" className="br-brand">світло<span>бот</span></a><nav><a href="/review">Застосунок і графіки</a><button onClick={() => update({theme:dark?'light':'dark'})}>{dark ? 'Світла тема' : 'Темна тема'}</button></nav></header>
    <div className="br-intro"><span className="br-eyebrow">ПЕРЕВІРТЕ РОЗМОВУ</span><h1>Менше пошуку.<br />Більше ясності.</h1><p>Адреси, план і потрібні налаштування — в одній розмові.</p><p className="br-disclosure">Локальний інтерактивний приклад. Дані вигадані. Цей екран не надсилає повідомлень у Telegram.</p></div>
    <div className="br-layout"><aside className="br-controls"><details className="br-test-panel"><summary>Тестові дані й профіль</summary><h2>Сценарій</h2><p>Почніть з порожнього профілю або профілю з однією адресою.</p><div className="br-stack"><button disabled={busy || Boolean(pending)} onClick={() => reset('new')}>Новий користувач</button><button disabled={busy || Boolean(pending)} onClick={() => reset('returning')}>Профіль з адресою</button></div><label>Стан джерела<select aria-label="Стан джерела" value={status} disabled={busy || Boolean(pending)} onChange={event => setStatus(event.target.value as PlanStatus)}>{Object.entries(PLAN_STATUS_COPY).map(([id, copy]) => <option key={id} value={id}>{copy.title}</option>)}</select></label><small>Стан застосовується до наступного запиту графіка. Попередні картки зберігають свою ревізію.</small><h2>Збережений профіль</h2>{profile ? <><p>{profile.locations.length ? `${profile.locations.length} адреса(и)` : 'Адрес ще немає'}</p>{profile.locations.map(location => <div className="br-location" key={location.address.id}><strong>{location.address.label}</strong><span>{location.address.street}, {location.address.house.literal}</span><small>{location.paused ? 'Адреса на паузі' : location.notifications ? 'Telegram для адреси: увімкнено' : 'Telegram для адреси: вимкнено'}</small><small>Push для адреси: {location.notificationPolicy?.channels.push.enabled ? 'увімкнено' : 'вимкнено'}</small></div>)}<p className="br-pref">{profile.preferences.paused ? 'Усі повідомлення на паузі' : profile.preferences.optedIn ? 'Згоду на Telegram збережено' : 'Згоди на Telegram немає'}</p><p className="br-pref">Push у застосунку: {profile.preferences.notificationPolicy?.channels.push.enabled ? 'згоду збережено' : 'згоди немає'}</p></> : <p>Оберіть сценарій або напишіть /start.</p>}<details><summary>Про збереження</summary><p>Профіль і відповіді записуються разом у локальну тестову базу. Оновлення сторінки зберігає розмову. Кнопки зі старого меню не змінять нові налаштування.</p>{snapshot.receipt && <code>Ревізія {snapshot.receipt.sessionRevision} · {snapshot.receipt.committed ? 'збережено' : 'очікуємо'}</code>}</details></details></aside>
    <section className="br-chat" aria-label="Розмова з ботом"><div className="br-chat-heading"><span className="br-avatar">с</span><div><h2>Світло Україна</h2><p>Тестова розмова · без надсилання</p></div><span className="br-status">локально</span></div><div className="br-messages" aria-live="polite">{!snapshot.messages.length && <div className="br-empty"><strong>Почнімо з вашої адреси</strong><p>Натисніть /start. Для тесту доступні «Тестове місто», «вулиця Нова» та будинки 12, 12А, 12/1, 12-1 і 12 корпус 1.</p><button disabled={busy || Boolean(pending)} onClick={() => command('/start')}>Почати розмову</button></div>}{snapshot.messages.length > 1 && <details className="br-history"><summary>Попередні повідомлення · {snapshot.messages.length - 1}</summary>{snapshot.messages.slice(0, -1).map(renderMessage)}</details>}
      {latest && renderMessage(latest)}
      {activeButtons.length > 0 && <div className="br-buttons" aria-label="Дії поточного кроку">{activeButtons.map(button => <button key={button.callbackId} disabled={busy || Boolean(pending)} onClick={() => send({ id: crypto.randomUUID(), kind: 'callback', callbackId: button.callbackId })}>{button.label}</button>)}</div>}
      {latest && !activeButtons.length && latest.buttons.length > 0 && <p className="br-expired">Ці кнопки вже неактивні. Відкрийте свіже меню нижче.</p>}
      <div ref={end} /></div><div className="br-compose"><div className="br-compose-tools"><button disabled={busy || Boolean(pending)} onClick={() => command('/menu')}>Меню</button><details><summary>Команди</summary><div className="br-commands">{commands.map(text => <button key={text} disabled={busy || Boolean(pending)} onClick={() => command(text)}>{text}</button>)}</div></details></div>{error && <div className="br-error" role="alert"><p>{error}</p>{pending && <><small>Результат запиту ще не підтверджено. Повтор використає той самий ID і не виконає дію двічі.</small><button disabled={busy} onClick={() => send(pending.input, pending.status)}>Перевірити й повторити запит</button></>}</div>}<form onSubmit={event => { event.preventDefault(); if (text.trim()) void send({ id: crypto.randomUUID(), kind: text.trim().startsWith('/') ? 'command' : 'text', text: text.trim() }); }}><label className="br-visually-hidden" htmlFor="bot-message">Ваше повідомлення</label><input id="bot-message" value={text} onChange={event => setText(event.target.value)} disabled={busy || Boolean(pending)} placeholder="Напишіть повідомлення…" maxLength={1000} autoComplete="off" /><button disabled={busy || Boolean(pending) || !text.trim()}>{busy ? 'Зберігаємо…' : 'Надіслати'}</button></form></div></section></div>
  </main>;
}
