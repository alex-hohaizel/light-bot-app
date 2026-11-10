/** Source-owned deployment authority only. Future entries require root review
 * of exact bundle and independent review receipt bytes. No environment, HTTP,
 * profile or runtime setter can populate this list. Keep pins separate from the
 * semantic validator so the bundle can pin that validator without a hash cycle. */
export interface PinnedQualificationFile {path:string;sha256:string}
export interface DeployedQualificationPin {bundle:PinnedQualificationFile;reviewReceipt:PinnedQualificationFile}
export const DEPLOYED_QUALIFICATION_PINS:readonly DeployedQualificationPin[]=Object.freeze([]);

/** Separate, source-owned owner amendment. No JSON/env setter and no 48h claim.
 * Each issuance still requires the exact current raw source in the owner TX. */
export const INITIAL_LAUNCH_NOTIFICATION_POLICY=Object.freeze({
 kind:'lba-owner-approved-initial-launch/1' as const,
 authority:'docs/light-bot-app/release-v8/FAST_LAUNCH_OWNER_SCOPE_2026-11-10_UA.md',
 acceptedAt:'2026-11-10T09:59:00Z',validUntil:'2026-12-10T09:59:00Z',
 sources:Object.freeze([
  Object.freeze({sourceId:'yasno-kem',operatorId:'dtek-kem',namespace:'yasno:25/902'}),
  Object.freeze({sourceId:'voe-mirror-vn-progr',operatorId:'vinnytsia-oe',namespace:'voe:vinnytsia'}),
  Object.freeze({sourceId:'kharkiv-official-rss',operatorId:'kharkiv-oe',namespace:'kharkiv:rss'}),
  Object.freeze({sourceId:'dtek-oem-public-plan-ajax',operatorId:'dtek-oem',namespace:'dtek:oem'}),
  Object.freeze({sourceId:'mirror-odesa',operatorId:'dtek-oem',namespace:'dtek:oem'}),
 ]),
});
