import {SOURCE_PROFILES,type SourceAdmission,type TechnicalDisplayAdmission} from './source-intake.ts';

/** Shared by plan ingestion and public address lookup, never a provider quota. */
export const YASNO_SHARED_ORIGIN_BUDGET_MS=1000;

export const TECHNICAL_SOURCE_REVIEW=Object.freeze({
 reviewedAt:'2026-11-08T19:25:59Z',validUntil:'2026-12-08T19:25:59Z',
 recommendationSha256:'6e86cacb69514bca06f47e92bca1ab3c9a8eed949dee4fef521bd7e7868fe3ad',
 evidenceSha256:'01d1299a1f2b10e84910b218b041db97889f3feb32d420aebee94e5bdac84ade',
});
/** Historical incidents stay dated; they do not become a permanent ban on an
 * operator's later, independently compared daily plan. */
export const HISTORICAL_SOURCE_INCIDENTS=Object.freeze({
 'mirror-odesa':Object.freeze({serviceDate:'2026-11-08',officialRawSha256:'e22970ec853f47f5cca4572863633395fe1c6e9d1f7d7d3c2f31e0529f713e38',
  mirrorRawSha256:'b8a28623c0f3ef1d93ff10d1dcb67812588ec9516340bdf7591685ac41167570',cellDifferences:9,
  reason:'8Nov current-day mirror lagged official; retain quarantine evidence. 9Nov comparison does not admit this service date.'}),
});
export const ODESA_9NOV_SEMANTIC_SCOPE=Object.freeze({
 serviceDate:'2026-11-09',comparisonSha256:'96ce177b9e3c8baabfed677b2d9f6b30d692294ed8f65b9bb5800cc5dfa3a94c',
 officialRawSha256:'ecca5119c62c19b12e20bc0e10ec2be6f8c73103b927d43aabeaba0acb2fdda1',
 mirrorRawSha256:'e6831ab19c618a9187210cbe0c765bbe8028c4430d349d56890b5be519168cf5',
 targetPlanSha256s:Object.freeze({
  'GPV1.1':'a54135d51212cccbab410b46dab10be54da7d537e09be6fedd5c7f67ede5da7e',
  'GPV1.2':'65b9356842b34532151d7fa0e5bcbf8d23c8c8c3cb1a139b0c13a43f6a6ea351',
  'GPV2.1':'5f4f0486fb06e9535642b09b391b78d49f24af5a365d30fc0f84492baab4d876',
  'GPV2.2':'4701b351d2232083071dfb1c6b3267b107d946c7d0d1ba2c7db46d1e275a0f9a',
  'GPV3.1':'5ab0a94a570630e335e4af9ba22e839f736fbf83c9a053b0a9ad0e7e196a34b5',
  'GPV3.2':'d2f32bd01b0cdde24b2d915aafd10278c52fe7a6e06a08656d6f9b3589dbb34c',
  'GPV4.1':'637076b3503a2d61ab5e94065f758d5b133b92703ed1cc48c2463bd3ac89d1fd',
  'GPV4.2':'4ea61670806d3009bf46eb035f3c3bfa06542e9aa0e66aee2d0d6fcda1535249',
  'GPV5.1':'fe323826dd45be9fc4d95ae48418700bbaa45974cb65de8c160af544066b578f',
  'GPV5.2':'b255277a4c39d1776d541ed8e99d182de3e4917943af7c684cd2b6dc8886dd96',
  'GPV6.1':'dccb45074aa372c651c89b0dccaf443238a5f0ce20642fb200c934222c437fea',
  'GPV6.2':'b188056e7af011b440d604711d83985a4c3509ed3cb8a05659574f36264294ce',
 }),
});
/** Fresh source comparison overrides the earlier transport/parser admission.
 * Preserve reference parser capability; do not expose it as current operation. */
export const TECHNICAL_SOURCE_QUARANTINE=Object.freeze({
 'voe-mirror-vn-progr': 'Першоджерело графіка не підтверджено. Чинний парсер дзеркала бере дані з bezsvitla.com.ua і може заповнювати пропуски як наявність світла; свіжість JSON не доводить публікацію оператором. Плановий показ утримано до перевірки офіційного джерела та повноти даних. source-research-2026-11-09/vinnytsia-followup/provenance.json.',
 'kharkiv-official-rss': 'Чинність аварійного режиму після повідомлення 8Nov не підтверджена; план 9Nov є, фактичні/аварійні відступи невідомі. Утримувати точний плановий показ до scoped overlay/expiry/cancellation evidence; це не твердження про чинний emergency всюди. source-research-2026-11-09/semantic-observations.json.',
});
/** Explicit opt-in at the real service boundary. No network, jobs, DB or grants are
 * created here. These are local budgets, not invented provider quotas/licenses.
 */
export function technicalDisplaySourceRegistry(enabled=false):SourceAdmission[]{
 const allowed=new Set(['yasno-kem','voe-mirror-vn-progr','mirror-odesa','kharkiv-official-rss']);
 return SOURCE_PROFILES.map(profile=>{
  const quarantine=TECHNICAL_SOURCE_QUARANTINE[profile.sourceId as keyof typeof TECHNICAL_SOURCE_QUARANTINE];
  if(quarantine)return {sourceId:profile.sourceId,state:'blocked' as const,reason:quarantine};
  if(!enabled||!allowed.has(profile.sourceId)||profile.automationBlocked)return {sourceId:profile.sourceId,state:'blocked' as const,reason:profile.researchBlocker};
  const yasno=profile.parser==='yasno',rss=profile.parser==='kharkiv_rss';
  const comparedMirror=profile.sourceId==='mirror-odesa';
  // One shared YASNO origin budget also serves interactive address reads.
  // Background plan cadence remains five minutes below; this is local policy,
  // not a provider-published quota or a systematic data licence.
  const minIntervalMs=yasno?YASNO_SHARED_ORIGIN_BUDGET_MS:rss?2700000:600000;
  const record:TechnicalDisplayAdmission={sourceId:profile.sourceId,state:'technical_display',revisionId:comparedMirror?'technical-display/2026-11-09/mirror-odesa/compared-target-semantics':'technical-display/2026-11-08/'+profile.sourceId+(yasno?'/shared-origin-1s-plan-5m':''),
   reviewedAt:comparedMirror?'2026-11-08T23:38:41.462Z':TECHNICAL_SOURCE_REVIEW.reviewedAt,validUntil:comparedMirror?'2026-11-09T22:00:00Z':TECHNICAL_SOURCE_REVIEW.validUntil,
   accessCost:0,costEvidence:(comparedMirror?'9Nov':'8Nov')+' anonymous public GET without API key/subscription/payment; operational observation, not a price guarantee.',
   publicationBasis:{kind:yasno||rss?'official_public_feed':'publisher_public_syndication',evidence:profile.endpoint+' ; review sha256:'+(comparedMirror?ODESA_9NOV_SEMANTIC_SCOPE.comparisonSha256:TECHNICAL_SOURCE_REVIEW.recommendationSha256)},
   formalPrimaryDataLicense:'not_observed',providerQuota:'not_published_in_reviewed_sources',
   robots:{status:yasno?'unreadable_html':rss?'not_disallowed':'not_checked',evidence:yasno?'8Nov app.yasno.ua/robots.txt returned Incapsula HTML, not robots rules. API separately returned anonymous JSON; no challenge bypass.':rss?'8Nov official robots.txt does not disallow /uk/rss.xml. Official public RSS syndication.':'Public exact raw GitHub JSON endpoint and repository syndication; no claim of a checked robots policy or primary-data MIT.'},
   rate:{kind:'local_operating_budget',scope:'origin',minIntervalMs,evidence:'Local conservative shared-origin policy from review; provider numeric quota not published. Honor403/429 and pause on unknown limits.'},
   // Two mirrors share one10m origin budget: round-robin gives20m/source.
   cacheTtlMs:yasno?300000:rss?minIntervalMs:1200000,maxAgeMs:rss?10800000:7200000,
   addressBindingVerified:false,deliveryEligible:false,parallel48hAccepted:false,independentFallbackVerified:false,
   ...(comparedMirror?{semanticScope:ODESA_9NOV_SEMANTIC_SCOPE}:{})};
  return record;
 });
}
