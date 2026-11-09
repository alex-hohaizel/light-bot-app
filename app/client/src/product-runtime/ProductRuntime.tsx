import ProductReview from '../product-review/ProductReview';
import type { CoverageRecord } from '@shared/product-contract';
import coverage from '@shared/coverage-research.json';
import { useEffect, useRef, useState } from 'react';
import type { ProfileMutation, ProfileRequest } from '@shared/profile-mutation';
import type { ProductSnapshot } from '@shared/live-product';
import { clearPendingProfile, loadPendingProfile, savePendingProfile } from './pending-request';
import {profileErrorMessage} from '@shared/profile-errors';
import {profileResponseFailure,assertProfileSnapshotResponse,assertProfileCommitResponse} from './profile-response';

async function fetchProfile(request: ProfileRequest|undefined, mode:'review'|'live',ownerId?:string): Promise<ProductSnapshot> {
  const response = await fetch(mode==='live'?'/api/product/profile':'/api/review/profile', { cache: 'no-store', ...(request ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  } : {}) });
  let value:any;
  try{value=await response.json();}catch{throw Object.assign(new Error(profileErrorMessage('LIVE_PROFILE_UNAVAILABLE')),{status:response.status,code:'LIVE_PROFILE_UNAVAILABLE',definiteRejection:false});}
  if (!response.ok) {
    throw profileResponseFailure(response.status,value);
  }
  assertProfileSnapshotResponse(value,mode);
  if(request)assertProfileCommitResponse(value,request,mode,ownerId||'');
  return value;
}

// A projection of dated public-source research, never synthetic coverage claims.
export default function ProductRuntime({mode='review'}:{mode?:'review'|'live'}={}) {
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<ProfileRequest | null>(null), [lastMutationId, setLastMutationId] = useState('');
  const snapshotRef = useRef(snapshot), pendingRef = useRef(pending), working = useRef(false);
  const mounted=useRef(true);
  const requestSequence = useRef(0);
  snapshotRef.current = snapshot; pendingRef.current = pending;
  async function refresh(options?:{throwOnFailure?:boolean}) {
    if (working.current || pendingRef.current) {if(options?.throwOnFailure)throw Error('Спочатку перевірте результат попереднього збереження.');return;}
    const sequence = ++requestSequence.current;
    try { const value = await fetchProfile(undefined,mode); if (mounted.current&&sequence === requestSequence.current) {
      const recovered = loadPendingProfile(sessionStorage, value.profile.id, value.sessionId);
      snapshotRef.current = value; setSnapshot(value); pendingRef.current = recovered; setPending(recovered);
      setError(recovered ? 'Результат попереднього збереження ще не підтверджено. Перевірте той самий запит.' : '');
    }else if(options?.throwOnFailure)throw Error('Профіль змінився під час перевірки адреси. Повторіть вибір.'); }
    catch (error) { if (sequence === requestSequence.current) setError(error instanceof Error ? error.message : 'Немає зв’язку з локальним профілем.');if(options?.throwOnFailure)throw error; }
  }
  useEffect(() => {
    mounted.current=true;
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {mounted.current=false;++requestSequence.current;window.removeEventListener('focus', onFocus);};
  }, []);
  async function submit(request: ProfileRequest) {
    if (working.current) throw new Error('Дочекайтеся завершення попереднього запиту.');
    const current = snapshotRef.current;
    if (!current || current.sessionId !== request.expectedSessionId) throw new Error('Сесію змінено. Оновіть профіль.');
    // Persist before the network operation so reload cannot lose an unknown outcome.
    try { savePendingProfile(sessionStorage, current.profile.id, request); }
    catch { setError('Браузер не дозволив зберегти відновлення запиту. Зміни ще не надіслані.'); throw new Error('Не вдалося зберегти відновлення запиту.'); }
    ++requestSequence.current;
    working.current = true; setBusy(true); setError(''); pendingRef.current = request; setPending(request);
    try {
      const value = await fetchProfile(request,mode,current.profile.id);
      if(!mounted.current)return;
      snapshotRef.current = value; setSnapshot(value); pendingRef.current = null; setPending(null); setLastMutationId(request.id);
      try { clearPendingProfile(sessionStorage,{ownerId:current.profile.id,requestId:request.id,sessionId:request.expectedSessionId}); } catch {}
    } catch (error) {
      if(!mounted.current)throw error;
      const message = error instanceof Error ? error.message : 'Збереження ще не підтверджено.';
      setError(message);
      const status = (error as { status?: number }).status;
      if ((error as {definiteRejection?:boolean}).definiteRejection===true) {
        // A definite rejection is not an unknown commit; a deliberate retry gets a fresh ID/revision.
        pendingRef.current = null; setPending(null);
        try { clearPendingProfile(sessionStorage,{ownerId:current.profile.id,requestId:request.id,sessionId:request.expectedSessionId}); } catch {}
        if (status === 409) { const latest = await fetchProfile(undefined,mode).catch(() => null); if (latest&&mounted.current&&latest.profile.id===current.profile.id) { snapshotRef.current = latest; setSnapshot(latest); } }
      }
      throw error;
    } finally { working.current = false; setBusy(false); }
  }
  async function mutate(mutation: ProfileMutation) {
    if (snapshotRef.current?.simulationOnly===false && !snapshotRef.current.capabilities.profileMutations) throw new Error('Зміни поки недоступні: триває перевірка перенесення профілів.');
    if (pendingRef.current || !snapshotRef.current) throw new Error('Спочатку перевірте результат попереднього збереження.');
    const current = snapshotRef.current;
    await submit({ id: crypto.randomUUID(), expectedSessionId: current.sessionId, expectedRevision: current.revision, mutation });
  }
  const readOnly=snapshot?.simulationOnly===false&&!snapshot.capabilities.profileMutations;
  const notice = error || pending ? <div className="pr-runtime-error" role="alert"><span>{error || 'Перевіряємо збереження…'}</span>{pending ? <button disabled={busy} onClick={() => void submit(pending).catch(() => {})}>{busy ? 'Перевіряємо…' : 'Перевірити результат того самого запиту'}</button> : <button disabled={busy} onClick={() => void refresh()}>Оновити профіль</button>}{pending && <small>Нові зміни заблоковані до підтвердження. Повтор не дублює дію.</small>}</div> : <details className="pr-runtime-status"><summary>{busy ? 'Зберігаємо зміни…' : mode==='live'?(readOnly?'Перевірка перенесення · тільки перегляд':'Ваш профіль застосунку й бота'):'Тестовий профіль застосунку й бота'}</summary><span>{snapshot?.simulationOnly===false?snapshot.migration.message:`Ревізія ${snapshot?.revision}. PostgreSQL цього локального запуску.`}</span><button disabled={busy} onClick={() => void refresh()}>Оновити профіль</button></details>;
  return snapshot ? <ProductReview coverage={coverage as CoverageRecord[]} runtimeNotice={notice} runtimeError={Boolean(error||pending)} runtime={{snapshot,busy,blocked:busy||Boolean(pending)||readOnly,lastMutationId,mutate,refresh,...(pending?{retry:()=>submit(pending)}:{})}}/> : <main className="pr-app"><div className="pr-empty-state"><h1>Ваші адреси</h1><p>{error || (mode==='live'?'Отримуємо ваш збережений профіль…':'Отримуємо збережений тестовий профіль…')}</p><button className="pr-secondary" onClick={()=>void refresh()}>Оновити профіль</button></div></main>;
}
