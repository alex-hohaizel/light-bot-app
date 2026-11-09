import {Radio,Clock3} from 'lucide-react';
import {summarizeOperatorHouseNotice,type AddressOperatorHouseNotice} from '../../../shared/operator-house-notice.ts';
import './operator-house-notice.css';
/** One current house report. The day-axis and its group plan remain separate. */
export function OperatorHouseNoticePanel({notice,asOf,suspended=false}:{notice?:AddressOperatorHouseNotice;asOf:string;suspended?:boolean}){
 const summary=summarizeOperatorHouseNotice(notice,asOf,suspended);
 return <section className="pr-house-notice" data-state={summary.state} data-tone={summary.tone} aria-label="Повідомлення для будинку">
  <div className="pr-house-notice-heading"><Radio size={17} aria-hidden="true"/><strong>{summary.title}</strong><span>Зараз</span></div>
  <p>{summary.detail}</p>
  {summary.timing&&<p className="pr-house-notice-timing"><Clock3 size={16} aria-hidden="true"/><strong>{summary.timing}</strong></p>}
  {summary.outsideGroupPlan&&<p className="pr-house-notice-advisory">Повідомлення для будинку може діяти поза погодинним планом групи.</p>}
  {summary.footnote&&<details className="pr-house-notice-source"><summary>Час повідомлення</summary><p>{summary.footnote}</p></details>}
 </section>;
}
