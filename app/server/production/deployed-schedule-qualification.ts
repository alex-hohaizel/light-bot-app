/** Source-owned deployment authority only. Future entries require root review
 * of exact bundle and independent review receipt bytes. No environment, HTTP,
 * profile or runtime setter can populate this list. Keep pins separate from the
 * semantic validator so the bundle can pin that validator without a hash cycle. */
export interface PinnedQualificationFile {path:string;sha256:string}
export interface DeployedQualificationPin {bundle:PinnedQualificationFile;reviewReceipt:PinnedQualificationFile}
export const DEPLOYED_QUALIFICATION_PINS:readonly DeployedQualificationPin[]=Object.freeze([]);
