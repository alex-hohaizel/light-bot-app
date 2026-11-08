import type {ProfileSnapshot} from './profile-mutation.ts';

/** A live snapshot is a distinct contract. Synthetic receipts cannot certify it. */
export type LiveProfileSnapshot = Omit<ProfileSnapshot,'simulationOnly'|'receipt'> & {
  simulationOnly: false;
  serverNow: string;
  releaseId: string;
  capabilities: {profileMutations: boolean; tools: boolean};
  migration: {status:'checking'|'needs_confirmation';message:string};
  receipt?: Omit<NonNullable<ProfileSnapshot['receipt']>,'simulationOnly'> & {simulationOnly:false};
};
export type ProductSnapshot = ProfileSnapshot | LiveProfileSnapshot;
