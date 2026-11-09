import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeftRight, ArrowRight, Bell, ChevronDown, MapPin, Plus, Share2 } from 'lucide-react';
import type { ScheduleView } from '@shared/product-contract';
import type { DemoAddress } from './examples';
import { Building } from './Building';
import { axisFraction, createDayAxis, deriveOperational, inspectScheduleForDisplay, type OperationalState } from './operational';
import { displayDate, displayTime, durationLabel, intervalLabel } from './schedule-model';

export interface DistrictDashboardProps {
  addresses: DemoAddress[]; activeId: string; views: ScheduleView[]; asOf: string;
  day: 'today' | 'tomorrow';
  onSelect(id: string): void; onCompare(): void; onManage(): void;
  onNotifications(addressId?: string): void; onShare(): void;
  onDay(day: 'today' | 'tomorrow'): void; onAdd(): void;
}

/** Animate only an entry or a visible clock-value change, never interval selection. */
export function OperationalTime({ value }: { value: string }) {
  const previous = useRef(value), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [moving, setMoving] = useState(true);
  useEffect(() => {
    clearTimeout(timer.current);
    if (previous.current !== value) { setMoving(false); previous.current = value; }
    const frame = requestAnimationFrame(() => setMoving(true));
    timer.current = setTimeout(() => setMoving(false), 700);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer.current); };
  }, [value]);
  return <strong className="pr-district-time" data-moving={moving} aria-label={value}>
    {[...value].map((ch, index) => <span key={`${index}-${ch}`} aria-hidden="true" className={ch === ':' ? 'pr-district-colon' : 'pr-district-digit'} style={{ '--pr-digit-delay': `${index * 35}ms` } as CSSProperties}>{ch}</span>)}
  </strong>;
}

export function OperationalSummary({ state, compact = false }: { state: OperationalState; compact?: boolean }) {
  return <div className={compact ? 'pr-district-summary is-compact' : 'pr-district-summary'} data-phase={state.phase} data-possible={state.possible}>
    {state.phase !== 'complete' && <p className="pr-district-phase"><i aria-hidden="true" />{state.phaseLabel}</p>}
    {state.next ? <><p className="pr-district-event-label">{state.next.label}</p><OperationalTime value={state.next.time} />
      <p className="pr-district-remaining">{state.phase === 'outage' ? 'Залишилося' : 'Через'} <strong>{state.next.remainingLabel}</strong></p>
      {state.nextLaterOff && <p className="pr-district-secondary">Далі: {state.nextLaterOff.label.toLocaleLowerCase('uk-UA')} о {state.nextLaterOff.time}</p>}
    </> : <><p className="pr-district-no-time">{state.phase === 'complete' ? state.phaseLabel : 'Час невідомий'}</p><p className="pr-district-explanation">{state.reason}</p></>}
    {state.next && (state.possible || state.reason.startsWith('Відомо лише')) && <p className="pr-district-explanation">{state.reason}</p>}
  </div>;
}

export function DayPlanDetails({ view, asOf, initiallyOpen = false }: { view: ScheduleView; asOf: string; initiallyOpen?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null), display = inspectScheduleForDisplay(view, asOf);
  const { operational: state, historical, intervals } = display;
  let axis; try { if (!display.valid) throw new Error('INVALID_PLAN'); axis = createDayAxis(view.serviceDate); }
  catch { return <section className="pr-district-invalid" role="alert" data-plan-valid="false"><strong>Не вдалося перевірити план</strong><p>Інтервали не показуємо, бо їхню точність не підтверджено. Оновіть план і спробуйте ще раз.</p></section>; }
  const selectedInterval = intervals.find(i => `${i.startsAt}/${i.endsAt}` === selected);
  return <details className={`pr-district-day ${historical ? 'is-historical' : ''}`} data-plan-valid="true" data-historical={historical} open={initiallyOpen || undefined}>
    <summary><span><strong>{historical ? 'Останні відомі інтервали' : 'Увесь графік на день'}</strong><small>{historical ? 'Потребують оновлення' : intervals.length ? `${intervals.length} ${intervals.length === 1 ? 'інтервал' : intervals.length < 5 ? 'інтервали' : 'інтервалів'}` : state.phaseLabel}</small></span><ChevronDown size={18} /></summary>
    <div className="pr-district-day-body">
      {historical && <p className="pr-district-historical" role="status">Останні відомі інтервали · потребують оновлення. Вони не підтверджують поточний стан або час увімкнення.</p>}
      {intervals.length > 0 && <><div className="pr-district-axis" aria-hidden="true">{axis.ticks.map(t => <span key={t.at} style={{ left: `${t.fraction * 100}%` }}>{t.label}</span>)}</div>
        <div className={`pr-district-track ${historical ? 'is-historical is-uncertain' : ''}`} aria-label={`${historical ? 'Останні відомі інтервали' : 'Інтервали плану'}: ${intervals.map(i => `${intervalLabel(i, true)}${display.possible || i.kind === 'possible_outage' ? ', можливий інтервал' : ''}`).join(', ')}`}>
          {intervals.map(i => <span key={i.startsAt} className={`${display.possible || i.kind === 'possible_outage' ? 'is-possible' : ''} ${historical ? 'is-historical is-uncertain' : ''}`} style={{ left: `${axisFraction(i.startsAt, axis) * 100}%`, width: `${(axisFraction(i.endsAt, axis) - axisFraction(i.startsAt, axis)) * 100}%` }} />)}
          {!historical && Date.parse(asOf) >= axis.start && Date.parse(asOf) < axis.end && <i className="pr-district-now" style={{ left: `${axisFraction(asOf, axis) * 100}%` }} />}
        </div></>}
      <div className="pr-district-intervals">{intervals.map((interval, index) => {
        const key = `${interval.startsAt}/${interval.endsAt}`, current = !historical && state.currentIndex === index, possible = display.possible || interval.kind === 'possible_outage';
        return <button type="button" key={key} onClick={() => setSelected(selected === key ? null : key)} aria-pressed={selected === key} data-historical={historical} className={`pr-district-interval ${current ? 'is-current' : ''} ${possible ? 'is-possible' : ''} ${historical ? 'is-historical' : ''}`}>
          <span><strong>{intervalLabel(interval)}</strong><small>{possible ? 'Можливий інтервал' : historical ? 'Останній відомий інтервал' : 'Планове відключення'}{historical ? ' · потребує оновлення' : current ? possible ? ' · можливий зараз' : ' · зараз за графіком' : ''}</small></span>
          <span>{durationLabel((Date.parse(interval.endsAt) - Date.parse(interval.startsAt)) / 60000)}</span>
        </button>;
      })}</div>
      {selectedInterval && <div className={`pr-district-interval-detail ${historical ? 'is-historical' : ''}`} data-historical={historical} role="status"><strong>{display.possible || selectedInterval.kind === 'possible_outage' ? 'Можливий інтервал: ' : ''}{intervalLabel(selectedInterval, true)}</strong>{historical && <p>Останній відомий інтервал · потребує оновлення. Час наступної події не підтверджено.</p>}<p>Повна тривалість: {durationLabel((Date.parse(selectedInterval.endsAt) - Date.parse(selectedInterval.startsAt)) / 60000)}.</p>{!historical && state.currentInterval?.startsAt === selectedInterval.startsAt && <p>Минуло {durationLabel(state.elapsedMinutes || 0)}. {state.possible ? 'До можливого завершення інтервалу' : 'До завершення за графіком'} — {state.next?.remainingLabel}.</p>}</div>}
      {!intervals.length && <p className="pr-field-note">{state.reason}</p>}
      <p className="pr-district-legend"><i aria-hidden="true" />Планове відключення · штрихування — можливе. Проміжки поза планом не підтверджують фактичне живлення.{axis.minutes !== 1440 ? ` Ця доба триває ${durationLabel(axis.minutes)} через зміну годинника.` : ''}</p>
    </div>
  </details>;
}

export function DistrictDashboard({ addresses, activeId, views, asOf, day, onSelect, onCompare, onManage, onNotifications, onShare, onDay, onAdd }: DistrictDashboardProps) {
  const active = addresses.find(a => a.id === activeId), plan = views.find(v => v.addressId === activeId), display = inspectScheduleForDisplay(plan, asOf), state = display.operational;
  const date = display.valid ? plan!.serviceDate : views.find(v => inspectScheduleForDisplay(v, asOf).valid)?.serviceDate;
  if (!addresses.length) return <section className="pr-empty-state pr-district-empty"><MapPin size={32} /><h2>Почнімо з вашої адреси</h2><p>Додайте будинок, щоб бачити його план і налаштувати потрібні нагадування.</p><button type="button" className="pr-primary" onClick={onAdd}><Plus size={18} />Додати адресу</button></section>;
  return <section className="pr-district" aria-label="Адресний пульт">
    <div className="pr-district-context"><span>{date ? displayDate(date) : 'Плани збережених адрес'}</span><div className="pr-segmented" aria-label="Дата плану"><button type="button" aria-pressed={day === 'today'} className={day === 'today' ? 'is-active' : ''} onClick={() => onDay('today')}>Сьогодні</button><button type="button" aria-pressed={day === 'tomorrow'} className={day === 'tomorrow' ? 'is-active' : ''} onClick={() => onDay('tomorrow')}>Завтра</button></div></div>
    <header className="pr-district-heading"><div><p className="pr-eyebrow">ВАШІ ЗБЕРЕЖЕНІ МІСЦЯ</p><h2>Адресний пульт</h2></div><button type="button" className="pr-secondary" onClick={onManage}>Керувати<ArrowRight size={16} /></button></header>
    {plan?.notice&&<p className="pr-status-notice" role="note">{plan.notice}</p>}
    <div className="pr-district-workspace">
      <section className="pr-district-neighborhood" aria-label="Ваші збережені адреси"><div className="pr-district-section-heading"><h3>Кожне місце — поруч</h3><span>{addresses.length}</span></div>
        <div className="pr-district-buildings" role="list">{addresses.map(address => {
          const selected = address.id === activeId, status = deriveOperational(views.find(v => v.addressId === address.id), asOf);
          return <div role="listitem" key={address.id}><button type="button" className={`pr-district-house ${selected ? 'is-active' : ''}`} aria-pressed={selected} onClick={() => onSelect(address.id)} data-address-id={address.id} data-phase={status.phase}>
            <Building id={address.id} label={address.label} /><strong>{address.label}</strong><small>{status.phase === 'outage' ? status.possible ? 'Можливий інтервал' : 'Планове відключення' : status.phase === 'before' ? status.possible ? 'Можливе відключення' : 'За графіком' : status.phaseLabel}</small>
            {!selected && status.next && <span>{status.next.edge === 'on' ? 'Увімкнення' : 'Вимкнення'} <b>{status.next.time}</b></span>}
          </button></div>;
        })}</div>
        {addresses.length > 3 && <p className="pr-district-scroll-note">Гортайте будинки або відкрийте «Керувати», щоб знайти потрібне місце.</p>}
      </section>
      {active ? <section className="pr-district-console pr-panel" data-address-id={active.id} data-phase={state.phase}>
        <p className="pr-district-selected"><i aria-hidden="true" />Обране місце</p><h3>{active.label}</h3><p className="pr-district-address">{active.city} · {active.street}, {active.house}</p>
        <OperationalSummary state={state} />
        {state.phase === 'before' && plan && state.nextIndex >= 0 && <p className="pr-district-secondary">Інтервал до {plan.intervals[state.nextIndex].endLocal}</p>}
        <div className="pr-district-reminder"><button type="button" className="pr-primary" onClick={() => onNotifications(active.id)}><Bell size={17} />{state.next?.edge === 'on' ? 'Нагадати перед увімкненням' : state.next?.edge === 'off' ? 'Нагадати перед вимкненням' : 'Налаштувати нагадування'}</button></div>
      </section> : <section className="pr-panel pr-district-console"><h3>Оберіть будинок</h3><p>Його план і найближча подія з’являться тут.</p></section>}
      <section className="pr-district-day-section">{plan && active && <><DayPlanDetails key={`${active.id}/${plan.serviceDate}`} view={plan} asOf={asOf} />
        {display.valid && <details className="pr-district-source"><summary>Джерело й актуальність <ChevronDown size={14} /></summary><p>{plan.source.name}</p><p>Перевірено {displayTime(plan.observedAt)} · {plan.freshness === 'current' ? 'збережено актуальний план' : 'потрібне оновлення'}. Час Europe/Kyiv.</p><p>{state.reason}</p></details>}</>}
        <div className="pr-district-tools"><button type="button" className="pr-secondary" onClick={onCompare}><ArrowLeftRight size={17} />Порівняти адреси</button><button type="button" className="pr-secondary" onClick={onShare} disabled={!active}><Share2 size={17} />Поділитися планом</button></div>
      </section>
    </div>
  </section>;
}
export default DistrictDashboard;
