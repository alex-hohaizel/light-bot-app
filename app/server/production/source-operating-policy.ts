import type {OdesaPlanOperatingRecord} from './odesa-plan-source.ts';
import {SOURCE_PROFILES,type SourceAdmission,type TechnicalDisplayAdmission} from './source-intake.ts';
import {KHARKIV_TELEGRAM_SOURCE} from '../domain/kharkiv-telegram-adapter.ts';

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
/** Archived official9Nov publication scope; raw capture is provenance, not a freshness renewal. */
export const KHARKIV_9NOV_PUBLICATION_SCOPE=Object.freeze({
  "serviceDate": "2026-11-09",
  "itemUrl": "https://oblenergo.kharkiv.ua/uk/node/13883460",
  "publishedAt": "2026-11-08T20:18:03.000Z",
  "rawCaptureSha256": "96b817608a6a53cfdb53322d2ddd22e2826aacf5a0cf5ee1777819237286d720",
  "noticeSha256": "b8c44e239af71d9099683be40d1cc0fa9ce1c6164d574a40fab008ba7199d4f0",
  "targetPlanSha256s": {
    "1.1": "d5b0437df626d08315dda1002e15a4e38c43e51ee31bd153d71f3a2563b1da55",
    "1.2": "5575c66748a7ab12db97a1cde1f6ae224259449289fa1dcbecc226756482b696",
    "2.1": "486832c3e86b12457e513b1967574220a65f499a11f35ca33013ec0ab9bea6b4",
    "2.2": "f88dc3f7bbab179cbb409a6645c02c02ff1d71c46cfb127f131d113635cbcdaf",
    "3.1": "46d79f0eadeb21f6fa09a4a5ea449a0b6efdfe54a8d8b4616d353d292691b751",
    "3.2": "c11f4d8fc114a509cb6ce2db4893a599e72e4f4d74a308daca7a630b1e80695f",
    "4.1": "6575c3c7c29aecdda7e7837093199dd4403b30900521c1ff3a8a30cfb3d60131",
    "4.2": "95da0d9fa76c442ad66276818c0bd4ac9f21a27fe2e09da8f358dc97e5e40014",
    "5.1": "4c6e55d709796de7b7e2c8097f5355fd3e088cbb610ee888c18d37b3649c3222",
    "5.2": "4679f96f11f438b3098db2985f5ee4a276188e858a3cc403ea80dcb22fcac703",
    "6.1": "765cecf1b4afad1743d8209cfaba88ee9eca1b4fd26be569552d9e7346464a0e",
    "6.2": "66f4df2fe36bd1d3c1cb38fee1ce57b684f4b3d05e643267de20f3622b561ed0"
  }
});
Object.freeze(KHARKIV_9NOV_PUBLICATION_SCOPE.targetPlanSha256s);
/** Fresh source comparison overrides the earlier transport/parser admission.
 * Preserve reference parser capability; do not expose it as current operation. */
export const TECHNICAL_SOURCE_QUARANTINE=Object.freeze({
 'voe-mirror-vn-progr': 'Першоджерело графіка не підтверджено. Чинний парсер дзеркала бере дані з bezsvitla.com.ua і може заповнювати пропуски як наявність світла; свіжість JSON не доводить публікацію оператором. Плановий показ утримано до перевірки офіційного джерела та повноти даних. source-research-2026-11-09/vinnytsia-followup/provenance.json.',
});
/** Explicit opt-in at the real service boundary. No network, jobs, DB or grants are
 * created here. These are local budgets, not invented provider quotas/licenses.
 */
export function historicalTechnicalDisplaySourceRegistry(enabled=false):SourceAdmission[]{
 const allowed=new Set(['yasno-kem','voe-mirror-vn-progr','mirror-odesa','kharkiv-official-rss']);
 return SOURCE_PROFILES.map(profile=>{
  const quarantine=TECHNICAL_SOURCE_QUARANTINE[profile.sourceId as keyof typeof TECHNICAL_SOURCE_QUARANTINE];
  if(quarantine)return {sourceId:profile.sourceId,state:'blocked' as const,reason:quarantine};
  if(!enabled||!allowed.has(profile.sourceId)||profile.automationBlocked)return {sourceId:profile.sourceId,state:'blocked' as const,reason:profile.researchBlocker};
  const yasno=profile.parser==='yasno',rss=profile.parser==='kharkiv_rss';
  const comparedMirror=profile.sourceId==='mirror-odesa',kharkiv=profile.sourceId==='kharkiv-official-rss';
  // One shared YASNO origin budget also serves interactive address reads.
  // Background plan cadence remains five minutes below; this is local policy,
  // not a provider-published quota or a systematic data licence.
  const minIntervalMs=yasno?YASNO_SHARED_ORIGIN_BUDGET_MS:rss?2700000:600000;
  const record:TechnicalDisplayAdmission={sourceId:profile.sourceId,state:'technical_display',revisionId:kharkiv?'technical-display/2026-11-09/kharkiv-official-rss/dated-plan-unknown-overlay':comparedMirror?'technical-display/2026-11-09/mirror-odesa/compared-target-semantics':'technical-display/2026-11-08/'+profile.sourceId+(yasno?'/shared-origin-1s-plan-5m':''),
   reviewedAt:kharkiv?'2026-11-09T05:00:37.710Z':comparedMirror?'2026-11-08T23:38:41.462Z':TECHNICAL_SOURCE_REVIEW.reviewedAt,validUntil:kharkiv||comparedMirror?'2026-11-09T22:00:00Z':TECHNICAL_SOURCE_REVIEW.validUntil,
   accessCost:0,costEvidence:(kharkiv||comparedMirror?'9Nov':'8Nov')+' anonymous public GET without API key/subscription/payment; operational observation, not a price guarantee.',
   publicationBasis:{kind:yasno||rss?'official_public_feed':'publisher_public_syndication',evidence:profile.endpoint+' ; review sha256:'+(kharkiv?KHARKIV_9NOV_PUBLICATION_SCOPE.rawCaptureSha256:comparedMirror?ODESA_9NOV_SEMANTIC_SCOPE.comparisonSha256:TECHNICAL_SOURCE_REVIEW.recommendationSha256)},
   formalPrimaryDataLicense:'not_observed',providerQuota:'not_published_in_reviewed_sources',
   robots:{status:yasno?'unreadable_html':rss?'not_disallowed':'not_checked',evidence:yasno?'8Nov app.yasno.ua/robots.txt returned Incapsula HTML, not robots rules. API separately returned anonymous JSON; no challenge bypass.':rss?'8Nov reviewed official robots.txt does not disallow /uk/rss.xml;9Nov anonymous RSS GET is separately reobserved. No new robots/licence/quota claim.':'Public exact raw GitHub JSON endpoint and repository syndication; no claim of a checked robots policy or primary-data MIT.'},
   rate:{kind:'local_operating_budget',scope:'origin',minIntervalMs,evidence:'Local conservative shared-origin policy from review; provider numeric quota not published. Honor403/429 and pause on unknown limits.'},
   // Two mirrors share one10m origin budget: round-robin gives20m/source.
   cacheTtlMs:yasno?300000:rss?minIntervalMs:1200000,maxAgeMs:rss?10800000:7200000,
   addressBindingVerified:false,deliveryEligible:false,parallel48hAccepted:false,independentFallbackVerified:false,
   ...(comparedMirror?{semanticScope:ODESA_9NOV_SEMANTIC_SCOPE}:{}),...(kharkiv?{publicationScope:KHARKIV_9NOV_PUBLICATION_SCOPE}:{})};
  return record;
 });
}

/** Separate operation/dated local technical-display review. Robots crawler rules
 * are recorded as observed, never relabeled allowed or provider authorization.
 * This grants no personal binding, source qualification, notification or SLA. */
export function historicalOdesaPlanApiOperatingRecord(enabled=false):Readonly<OdesaPlanOperatingRecord>|null {
 if(enabled!==true)return null;
 return Object.freeze({kind:'lba-odesa-plan-operating-record/1',sourceId:'dtek-oem-public-plan-ajax',state:'technical_display',
  revisionId:'odesa-browser-api/2026-11-09/typed2hop-fact-update',reviewedAt:'2026-11-09T13:18:05.574Z',validUntil:'2026-11-09T22:00:00Z',
  accessCost:0,costEvidence:'9Nov ordinary anonymous guest GET + AJAX POST returned JSON without payment/API key; point observation, not a future price promise.',
  publicationBasis:Object.freeze({kind:'official_public_browser_api',evidence:'Official discon-schedule.js61de43eaff514b0b3726f38922d0745d17e98307989d424fc895f79cb68115a3; actual JSON65b132a17c1b7196b6d4c56bbec45be18e83581290b4e4bf9ebe6d29e72843e8, fact.update09.11.2026 10:52. Native diagnostic is not production client proof.'}),
  robots:Object.freeze({status:'crawler_disallow_observed',interpretation:'not_access_authorization',evidence:'9Nov wildcardDisallow:/ raw76c4269f170650b9c17b7abce80368d1331edc3434f5958edf9f7a53fe6dd991; recorded crawler policy, no claim of reuse permission. Separate public browser API action under owner scope; no challenge bypass or repeated HTML scraping.'}),
  formalPrimaryDataLicense:'not_observed',providerQuota:'not_published_in_reviewed_sources',
  rate:Object.freeze({kind:'local_operating_budget',scope:'origin',minIntervalMs:7500,evidence:'Shared CAS origin budget with address lookup; two requests at >=7.5s start spacing, <=30s deadline, five-minute plan cadence. Local limits only; stop/hold on access rejection.'}),
  cacheTtlMs:300000,maxAgeMs:7200000,cursorStrategy:'previous_kyiv_day_midnight_complete_matrix',
  addressBindingVerified:false,deliveryEligible:false,parallel48hAccepted:false,independentFallbackVerified:false});
}

/** Direct owner amendment for the initial launch. It replaces the initial
 * acceptance method only; it does not assert a provider licence, address proof,
 * an independent reserve, or a completed48h observation. No imports start IO. */
export const OWNER_APPROVED_INITIAL_LAUNCH=Object.freeze({
 kind:'OWNER_APPROVED_INITIAL_LAUNCH/1' as const,
 authority:'docs/light-bot-app/release-v8/FAST_LAUNCH_OWNER_SCOPE_2026-11-10_UA.md',
 reviewedAt:'2026-11-10T09:59:00Z',validUntil:'2026-12-10T09:59:00Z',
 scope:'recurring_current_and_next_kyiv_day_group_plans' as const,
});
/** Current runtime registry; the dated historical function above remains an
 * explicit replay oracle. Expired point comparisons never become a reserve. */
export function technicalDisplaySourceRegistry(enabled=false):SourceAdmission[]{
 const historical=historicalTechnicalDisplaySourceRegistry(enabled);
 return historical.map(entry=>{
  if(!enabled)return entry;
  if(entry.sourceId===KHARKIV_TELEGRAM_SOURCE){
   const record:TechnicalDisplayAdmission={
    sourceId:entry.sourceId,state:'technical_display',revisionId:OWNER_APPROVED_INITIAL_LAUNCH.kind+'/kharkiv-official-telegram/dated-12-queue-v1',
    reviewedAt:'2026-11-11T00:40:00Z',validUntil:OWNER_APPROVED_INITIAL_LAUNCH.validUntil,accessCost:0,
    costEvidence:'Ordinary 11 November anonymous HTTPS GET of the public channel returned 200 without a Telegram account, key or subscription.',
    publicationBasis:{kind:'official_public_feed',evidence:'Kharkivoblenergo public channel @kharkivenergy, post 2348. The 11 November 2026 local day and 12 groups were verified against the original publication.'},
    formalPrimaryDataLicense:'not_observed',providerQuota:'not_published_in_reviewed_sources',
    robots:{status:'not_checked',evidence:'Public channel preview path only. No credential, session, redirect or anti-bot workaround.'},
    rate:{kind:'local_operating_budget',scope:'origin',minIntervalMs:2700000,evidence:'One anonymous channel preview per 45 minutes; honor provider access and rate limits.'},
    cacheTtlMs:2700000,maxAgeMs:10800000,addressBindingVerified:false,deliveryEligible:false,parallel48hAccepted:false,independentFallbackVerified:false,
    recurringScope:{kind:'current_and_next_kyiv_day',authority:OWNER_APPROVED_INITIAL_LAUNCH.kind,parserVersion:'kharkiv-telegram-12-queue/1',maxPublicationAgeMs:129600000,emergencyOverlay:'unknown'},
   };
   return record;
  }
  const odesa=entry.sourceId==='mirror-odesa';
  if(odesa){
   const record:TechnicalDisplayAdmission={sourceId:entry.sourceId,state:'technical_display',revisionId:OWNER_APPROVED_INITIAL_LAUNCH.kind+'/mirror-odesa/recurring-fallback-v1',
    reviewedAt:OWNER_APPROVED_INITIAL_LAUNCH.reviewedAt,validUntil:OWNER_APPROVED_INITIAL_LAUNCH.validUntil,accessCost:0,
    costEvidence:'10Nov ordinary anonymous exact GitHub GET returned200 without a key, subscription or payment; point observation, not a future price guarantee.',
    publicationBasis:{kind:'publisher_public_syndication',evidence:'Baskerville42/outage-data-ua public community relay. Current10Nov source/date/12group matrix verified; official API guest metadata is currently unavailable. No current official semantic comparison or independent upstream confirmation is claimed.'},
    formalPrimaryDataLicense:'not_observed',providerQuota:'not_published_in_reviewed_sources',
    robots:{status:'not_checked',evidence:'Exact raw GitHub JSON endpoint; no newly claimed robots rule or primary-data licence.'},
    rate:{kind:'local_operating_budget',scope:'origin',minIntervalMs:300000,evidence:'Five-minute shared GitHub origin budget; source cadence and origin reservation are enforced together. Local policy only; honor403/429 and pause unknown access rejection.'},
    cacheTtlMs:300000,maxAgeMs:7200000,addressBindingVerified:false,deliveryEligible:false,parallel48hAccepted:false,independentFallbackVerified:false,
    recurringScope:{kind:'current_and_next_kyiv_day',authority:OWNER_APPROVED_INITIAL_LAUNCH.kind,parserVersion:'odesa-publisher-hour-matrix/1',maxPublicationAgeMs:129600000,emergencyOverlay:'unknown'},
   };return record;
  }
  const vinnytsia=entry.sourceId==='voe-mirror-vn-progr',kharkiv=entry.sourceId==='kharkiv-official-rss';
  if(!vinnytsia&&!kharkiv)return entry;
  const profile=SOURCE_PROFILES.find(p=>p.sourceId===entry.sourceId)!;
  const record:TechnicalDisplayAdmission={
   sourceId:profile.sourceId,state:'technical_display',revisionId:OWNER_APPROVED_INITIAL_LAUNCH.kind+'/'+profile.sourceId+(vinnytsia?'/recurring-v3':'/recurring-v2'),
   reviewedAt:OWNER_APPROVED_INITIAL_LAUNCH.reviewedAt,validUntil:OWNER_APPROVED_INITIAL_LAUNCH.validUntil,
   accessCost:0,costEvidence:vinnytsia?'10Nov anonymous public GitHub JSON GET returned200 without a key, subscription or payment; local observation, not a price guarantee.':'10Nov anonymous official RSS GET returned200 without a key, subscription or payment; local observation, not a price guarantee.',
   publicationBasis:{kind:vinnytsia?'publisher_public_syndication':'official_public_feed',evidence:vinnytsia?'Owner approved community fallback after official browser-aware TLS client403. vn-progr/gpv-voe-vinnytsia publishes data collected from bezsvitla.com.ua; this is neither the official VOE feed nor independent primary confirmation.':profile.endpoint+' ; official dated12-queue publication, matching title/body date, item origin and RFC publication time checked per capture.'},
   formalPrimaryDataLicense:'not_observed',providerQuota:'not_published_in_reviewed_sources',
   robots:{status:vinnytsia?'not_checked':'not_disallowed',evidence:vinnytsia?'Exact public raw GitHub JSON; no newly claimed robots rule or primary-data licence.':'Reviewed official robots rules do not disallow /uk/rss.xml; ordinary anonymous RSS access, no challenge bypass.'},
   rate:{kind:'local_operating_budget',scope:'origin',minIntervalMs:vinnytsia?300000:2700000,evidence:'Finite owner-approved local operating budget; no provider quota claim. Honor403/429 and hold unknown access rejection.'},
   cacheTtlMs:vinnytsia?1200000:2700000,maxAgeMs:vinnytsia?7200000:10800000,
   addressBindingVerified:false,deliveryEligible:false,parallel48hAccepted:false,independentFallbackVerified:false,
   recurringScope:{kind:'current_and_next_kyiv_day',authority:OWNER_APPROVED_INITIAL_LAUNCH.kind,
    parserVersion:vinnytsia?'vn-progr-hour-matrix/1.0.0':'kharkiv-dated-12-queue/2',
    // An unchanged, dated plan can still apply throughout its service day.
    // Observation freshness is governed separately by cacheTtlMs/maxAgeMs.
    maxPublicationAgeMs:vinnytsia?129600000:259200000,emergencyOverlay:'unknown'},
  };
  return record;
 });
}
/** Same typed two-hop protocol, renewed finite operating authority. The strict
 * capture parser still checks current effective dates, publication time, source
 * identity, body digest, complete matrix and standard native transport. */
export function odesaPlanApiOperatingRecord(enabled=false):Readonly<OdesaPlanOperatingRecord>|null {
 const historical=historicalOdesaPlanApiOperatingRecord(enabled);
 if(!historical)return null;
 return Object.freeze({...historical,
  revisionId:OWNER_APPROVED_INITIAL_LAUNCH.kind+'/dtek-oem-public-plan-ajax/recurring-current-next-v2',
  reviewedAt:OWNER_APPROVED_INITIAL_LAUNCH.reviewedAt,validUntil:OWNER_APPROVED_INITIAL_LAUNCH.validUntil,
  costEvidence:'Owner initial-launch scope renews the observed free anonymous guest API for30days. No key/subscription/payment; current HTTP rejection pauses acquisition. No provider price or licence guarantee.',
  publicationBasis:Object.freeze({...historical.publicationBasis,evidence:historical.publicationBasis.evidence+'; OWNER_APPROVED_INITIAL_LAUNCH/1 recurring current/next-day parser; historical9Nov capture is protocol evidence, never a freshness renewal.'}),
 });
}
