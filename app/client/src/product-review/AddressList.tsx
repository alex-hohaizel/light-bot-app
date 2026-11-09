import { Activity, ArrowRight, Check, House, Plus } from 'lucide-react';
import { useState } from 'react';
import type { DemoAddress } from './examples';
import type { ProfileMutation } from '@shared/profile-mutation';

export function AddressList({ addresses, blocked, onAdd, onPlan, onLabel, onReplace, onCompare, onNotifications, onDelete, mutate }: {
  addresses: DemoAddress[]; blocked: boolean; onAdd(): void; onPlan(id: string): void; onLabel(id: string): void;
  onReplace(address: DemoAddress): void; onCompare(id: string): void; onNotifications(id: string): void;
  onDelete(address: DemoAddress): void; mutate(mutation: ProfileMutation): void;
}) {
  const [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const matched = addresses.filter(item => `${item.label} ${item.city} ${item.street} ${item.house}`.toLocaleLowerCase('uk-UA').includes(query.trim().toLocaleLowerCase('uk-UA')));
  const pageCount = Math.max(1, Math.ceil(matched.length / 4)), safePage = Math.min(page, pageCount - 1);
  return <section>
    <div className="pr-section-intro"><div><h2>Важливі місця — у вашому порядку.</h2><p>Відкрийте план або дії конкретної адреси. Мітка й заміна будинку — окремі зміни.</p></div><button className="pr-primary" disabled={addresses.length >= 20 || blocked} onClick={onAdd}><Plus size={17} />Додати адресу</button></div>
    <label className="pr-context-picker">Знайти адресу<input aria-label="Знайти збережену адресу" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Мітка, місто або вулиця" /></label>
    <div className="pr-address-grid">{matched.slice(safePage * 4, (safePage + 1) * 4).map(item => <article className="pr-panel pr-address-card" key={item.id} data-testid={`review-address-${item.id}`}>
      <div className="pr-address-card-top"><span className="pr-location-icon"><House size={22} /></span>{item.primary && <span className="pr-pill">Основна</span>}</div><h2>{item.label}</h2><p>{item.city}, {item.street}, {item.house}</p>
      <span className={`pr-pill ${!item.confirmedInDemo ? 'pr-pill-amber' : ''}`}>{item.confirmedInDemo ? <Check size={13} /> : <Activity size={13} />}{item.confirmedInDemo ? 'Прив’язка до графіка перевірена' : 'Потрібна перевірка будинку'}</span>
      {item.paused && <p className="pr-paused-note">Сповіщення адреси на паузі; згоду й час збережено.</p>}
      <div className="pr-address-actions"><button className="pr-secondary" onClick={() => onPlan(item.id)}>Відкрити план<ArrowRight size={15} /></button>
        <details className="pr-address-menu"><summary>Дії адреси</summary><div>
          <button onClick={() => onLabel(item.id)}>Змінити мітку</button>
          <button onClick={() => onReplace(item)}>Замінити будинок</button>
          <button disabled={blocked || item.primary} onClick={() => mutate({ kind: 'primary', addressId: item.id })}>{item.primary ? 'Це основна адреса' : 'Зробити основною'}</button>
          {addresses.findIndex(value => value.id === item.id) > 0 && <button disabled={blocked} onClick={() => mutate({ kind: 'move', addressId: item.id, direction: 'up' })}>Перемістити вище</button>}
          {addresses.findIndex(value => value.id === item.id) < addresses.length - 1 && <button disabled={blocked} onClick={() => mutate({ kind: 'move', addressId: item.id, direction: 'down' })}>Перемістити нижче</button>}
          <button disabled={blocked} onClick={() => mutate({ kind: 'location', addressId: item.id, paused: !item.paused })}>{item.paused ? 'Відновити сповіщення адреси' : 'Призупинити сповіщення адреси'}</button>
          <button onClick={() => onCompare(item.id)}>Порівняти з іншими</button>
          <button onClick={() => onNotifications(item.id)}>Налаштувати сповіщення</button>
          <button disabled={blocked} className="pr-danger-text" onClick={() => onDelete(item)}>Видалити адресу</button>
        </div></details>
      </div>
    </article>)}</div>
    {!matched.length && <p className="pr-status-notice">Адрес із таким запитом немає. Ваш профіль збережено.</p>}
    <div className="pr-pagination"><button className="pr-secondary" disabled={safePage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Попередні адреси</button><span>Сторінка {safePage + 1} з {pageCount}</span><button className="pr-secondary" disabled={safePage >= pageCount - 1} onClick={() => setPage(value => value + 1)}>Наступні адреси</button></div>
    <p className="pr-field-note">Збережено {addresses.length} з 20 адрес. Старі адреси й відмова від сповіщень зберігаються незалежно від перейменувань та недоступності джерела.</p>
  </section>;
}
