import type {ProfileSnapshot} from './profile-mutation.ts';
import type {ManualGroup} from './bot/types.ts';

export interface LiveProfileReceipt {
  id:string;inputId:string;committed:true;sessionRevision:number;simulationOnly:false;
  sessionId:string;recordedAt:string;delivery:'pending'|'none';
}
/** A live snapshot is a distinct contract. Synthetic receipts cannot certify it. */
export type LiveProfileSnapshot = Omit<ProfileSnapshot,'simulationOnly'|'receipt'> & {
  simulationOnly: false;
  serverNow: string;
  releaseId: string;
  /** Current server-owned technical groups, separate from verified address lookup. */
  manualGroups?: ManualGroup[];
  capabilities: {profileMutations: boolean; tools: boolean;addressLookupV2?:Array<'dtek:oem'>};
  migration: {status:'checking'|'needs_confirmation'|'ready';message:string};
  receipt?: LiveProfileReceipt;
};
export interface LiveProfileReceiptRecovery {
  outcome:'committed'|'not_recorded';receipt:LiveProfileReceipt|null;
  nextAction:'use_receipt'|'retry_same_request';
}
export type ProductSnapshot = ProfileSnapshot | LiveProfileSnapshot;
