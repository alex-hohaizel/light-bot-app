import { useState } from 'react';
import { ArrowRight, Bell, ChevronDown, Share2 } from 'lucide-react';
import type { ScheduleView } from '@shared/product-contract';
import type { DemoAddress } from './examples';
import { Building } from './Building';
import { DayPlanDetails } from './DistrictDashboard';
import { axisFraction, createDayAxis, inspectScheduleForDisplay, sharedClearWindows } from './operational';
import { displayDate, durationLabel, intervalLabel } from './schedule-model';

export interface SharedDayComparisonProps {
  addresses: DemoAddress[]; activeId: string; views: ScheduleView[]; asOf: string;
  selectedIds: string[]; onSelectedIds(ids: string[]): void; onFocus(id: string): void;
  onNotifications(addressId?: string): void; onShare(): void;
  day?: 'today' | 'tomorrow'; onDay?(day: 'today' | 'tomorrow'): void;
}
export function SharedDayComparison({ addresses, activeId, views, asOf, selectedIds, onSelectedIds, onFocus, onNotifications, onShare, day, onDay }: SharedDayComparisonProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedInterval, setSelectedInterval] = useState<{ addressId: string; key: string } | null>(null);
  const included = addresses.filter(a => selectedIds.includes(a.id));
  const excluded = addresses.filter(a => !selectedIds.includes(a.id));
  const serviceDate = views.find(v => included.some(a => a.id === v.addressId))?.serviceDate || views[0]?.serviceDate;
  let axis; try { axis = serviceDate ? createDayAxis(serviceDate) : null; } catch { axis = null; }
  const pairs = included.map(address => ({ address, view: views.find(v => v.addressId === address.id && v.serviceDate === serviceDate) }));
  const gaps = pairs.some(p => !p.view) ? null : sharedClearWindows(pairs.map(p => p.view!), asOf);
  const toggle = (id: string) => onSelectedIds(addresses.filter(a => a.id === id ? !selectedIds.includes(id) : selectedIds.includes(a.id)).map(a => a.id));
  return <section className="pr-comparison" aria-label="Спільна доба збережених адрес">
    <header className="pr-comparison-heading"><p className="pr-eyebrow">ПЛАНУЙТЕ МІЖ АДРЕСАМИ</p><h2>Один день. Різні графіки.</h2><p>Часова вісь спільна. Кожен будинок має свій рядок.</p></header>
    {day && onDay && <div className="pr-comparison-date"><span>{serviceDate ? displayDate(serviceDate) : 'Дата плану'}</span><div className="pr-segmented" aria-label="Дата порівняння"><button type="button" aria-pressed={day === 'today'} className={day === 'today' ? 'is-active' : ''} onClick={() => onDay('today')}>Сьогодні</button><button type="button" aria-pressed={day === 'tomorrow'} className={day === 'tomorrow' ? 'is-active' : ''} onClick={() => onDay('tomorrow')}>Завтра</button></div></div>}
    <section className="pr-panel pr-comparison-surface">
      <div className="pr-comparison-top"><div><h3>Спільна доба</h3><p>Порівнюємо {included.length} із {addresses.length} збережених адрес.</p></div>
        <details className="pr-comparison-picker"><summary>Обрати адреси<ChevronDown size={15} /></summary><fieldset><legend>Адреси у порівнянні</legend>{addresses.map(address => <label key={address.id}><input type="checkbox" checked={selectedIds.includes(address.id)} onChange={() => toggle(address.id)} /><span>{address.label}</span></label>)}<button type="button" className="pr-text-button" onClick={() => onSelectedIds(addresses.map(a => a.id))}>Обрати всі</button></fieldset></details>
      </div>
      {!addresses.length ? <div className="pr-empty-state"><h3>Ще немає збережених адрес</h3><p>Додайте місце в розділі «Мої адреси», щоб побачити його графік.</p></div>
        : !included.length ? <div className="pr-empty-state"><h3>Оберіть адреси для порівняння</h3><p>Покажемо лише ті місця, які ви оберете.</p><button type="button" className="pr-primary" onClick={() => onSelectedIds(addresses.map(a => a.id))}>Порівняти всі адреси</button></div>
          : !axis ? <div className="pr-empty-state"><h3>Не вдалося підтвердити дату плану</h3><p>Оновіть дані перед порівнянням інтервалів.</p></div> : <>
            <div className="pr-comparison-axis" aria-hidden="true">{axis.ticks.map(tick => <span key={tick.at} style={{ left: `${tick.fraction * 100}%` }}>{tick.label}</span>)}</div>
            <div className="pr-comparison-rows">{pairs.map(({ address, view }) => {
              const display = inspectScheduleForDisplay(view, asOf), { operational: state, historical, intervals } = display, expanded = expandedId === address.id;
              const selection = intervals.find(i => selectedInterval?.addressId === address.id && selectedInterval.key === `${i.startsAt}/${i.endsAt}`);
              return <article key={address.id} className={`pr-comparison-row ${activeId === address.id ? 'is-active' : ''} ${historical ? 'is-historical' : ''}`} data-address-id={address.id} data-phase={state.phase} data-plan-valid={display.valid} data-historical={historical}>
                <button type="button" className="pr-comparison-row-head" onClick={() => setExpandedId(expanded ? null : address.id)} aria-expanded={expanded}>
                  <Building id={address.id} label={address.label} /><span className="pr-comparison-identity"><strong>{address.label}</strong><small>{state.phaseLabel}</small></span>
                  <span className="pr-comparison-next">{state.next ? <><span>{state.possible ? 'Можливе ' : ''}{state.next.edge === 'on' ? 'увімкнення' : 'вимкнення'}</span><strong>{state.next.time}</strong><small>Через {state.next.remainingLabel}</small></> : <small>{state.phase === 'complete' ? view?.status === 'no_planned_outages' ? 'Без планових відключень' : 'Більше інтервалів немає' : 'Час невідомий'}</small>}</span><ChevronDown size={15} />
                </button>
                {historical && <p className="pr-comparison-historical" role="status">Останні відомі інтервали · потребують оновлення. Час наступної події не підтверджено.</p>}
                {intervals.length ? <div className={`pr-comparison-track ${historical ? 'is-historical is-uncertain' : ''}`} aria-label={`${historical ? 'Останні відомі інтервали' : 'Графік'} адреси ${address.label}`}>
                  {axis.ticks.map(t => <i key={t.at} className="pr-comparison-grid" style={{ left: `${t.fraction * 100}%` }} />)}
                  {intervals.map(interval => {
                    const key = `${interval.startsAt}/${interval.endsAt}`, possible = display.possible || interval.kind === 'possible_outage';
                    return <button type="button" key={key} data-historical={historical} className={`${possible ? 'is-possible' : ''} ${historical ? 'is-historical is-uncertain' : ''} ${selectedInterval?.addressId === address.id && selectedInterval.key === key ? 'is-selected' : ''}`} style={{ left: `${axisFraction(interval.startsAt, axis!) * 100}%`, width: `${(axisFraction(interval.endsAt, axis!) - axisFraction(interval.startsAt, axis!)) * 100}%` }} aria-label={`${address.label}: ${intervalLabel(interval, true)}${possible ? ', можливий інтервал' : ''}${historical ? ', останній відомий, потребує оновлення' : ''}`} onClick={() => { setExpandedId(address.id); setSelectedInterval({ addressId: address.id, key }); }} />;
                  })}
                  {!historical && Date.parse(asOf) >= axis.start && Date.parse(asOf) < axis.end && <i className="pr-comparison-now" style={{ left: `${axisFraction(asOf, axis) * 100}%` }} />}
                </div> : <p className="pr-comparison-unknown">{state.reason}</p>}
                {expanded && <div className="pr-comparison-detail">
                  {selection && <div className={`pr-district-interval-detail ${historical ? 'is-historical' : ''}`} data-historical={historical} role="status"><strong>{display.possible || selection.kind === 'possible_outage' ? 'Можливий інтервал' : 'Обраний інтервал'}: {intervalLabel(selection, true)}</strong>{historical && <p>Останній відомий інтервал · потребує оновлення. Час наступної події не підтверджено.</p>}<p>Повна тривалість: {durationLabel((Date.parse(selection.endsAt) - Date.parse(selection.startsAt)) / 60000)}.{!historical && ' Найближча подія адреси залишається в її рядку.'}</p></div>}
                  {view && <DayPlanDetails key={`${address.id}/${view.serviceDate}`} view={view} asOf={asOf} initiallyOpen />}
                  <div className="pr-comparison-actions"><button type="button" className="pr-text-button" onClick={() => onFocus(address.id)}>Відкрити пульт<ArrowRight size={16} /></button><button type="button" className="pr-text-button" onClick={() => onNotifications(address.id)}><Bell size={16} />Нагадування</button></div>
                </div>}
              </article>;
            })}</div>
            <p className="pr-comparison-legend">Бурштинові відрізки — планові відключення, штрихування — можливі. Лінія позначає час перегляду.{axis.minutes !== 1440 ? ` Ця місцева доба триває ${durationLabel(axis.minutes)}.` : ''}</p>
            <details className="pr-comparison-windows"><summary>Спільні проміжки поза плановими відключеннями<ChevronDown size={16} /></summary>
              {gaps === null ? <p>Не для всіх обраних адрес є повний актуальний план. Спільні проміжки поки не підтверджені.</p> : gaps.length ? <><div>{gaps.map(gap => <span key={gap.startsAt}><strong>{gap.startLabel}–{gap.endLabel}</strong><small>{durationLabel(gap.minutes)}</small></span>)}</div><p>Це проміжки поза опублікованими плановими інтервалами, а не гарантія фактичного живлення.</p></> : <p>У решті цієї доби спільного проміжку поза плановими інтервалами немає.</p>}
            </details>
            <button type="button" className="pr-secondary pr-comparison-share" onClick={onShare}><Share2 size={16} />Поділитися порівнянням</button>
          </>}
      {excluded.length > 0 && <p className="pr-comparison-excluded">Не включені: {excluded.map(a => a.label).join(', ')}. Їхній план не враховується у спільних проміжках.</p>}
    </section>
  </section>;
}
export default SharedDayComparison;
