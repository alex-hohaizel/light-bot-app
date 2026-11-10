import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileCampaignProvenUnissued} from '../../server/release/update-campaign-pg.ts';
test('operator reconciliation rejects malformed authority inputs before connecting to any database',async()=>{
 let connections=0;const pool={async connect(){connections++;throw Error('must_not_connect');}};
 const base={binding:{releaseId:'prior',deploymentId:'deployment',buildSha256:'a'.repeat(64),botId:'8577497098',origin:'https://power-ukraine.net'},controlEpoch:1,audienceSize:8,predecessorSenderSha256:'b'.repeat(64),operatorCodeSha256:'c'.repeat(64)};
 for(const request of [{...base,binding:{...base.binding,origin:'https://other.invalid'}},{...base,audienceSize:0},{...base,controlEpoch:0},{...base,operatorCodeSha256:'not-a-hash'}])await assert.rejects(reconcileCampaignProvenUnissued(pool,request),/PROVEN_UNISSUED_OPTIONS/);
 assert.equal(connections,0);
});
