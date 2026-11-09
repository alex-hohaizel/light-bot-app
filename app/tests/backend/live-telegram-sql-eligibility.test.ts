import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {telegramOwnerRecipientRef,verifiedEmptyReplyOrigin} from '../../server/production/telegram-dispatch-eligibility.ts';
const now='2026-11-09T00:05:00+02:00',digest='a'.repeat(64);
function row(){return{originKind:'verified_empty',sourceDigest:digest,bootstrapDigest:digest,provenance:{emptyAccountProof:{kind:'verified_empty_account',ownerId:'owner',accountState:'existing_empty',accountRevisionId:'users:'+digest,evidenceRef:'users-primary-key/same-transaction',legacySourceDigest:digest,verifiedAt:'2026-11-08T18:00:00Z'}}};}
test('reply-only empty lineage requires exact canonical historical proof, owner and origin/bootstrap digest; it is not an arbitrary empty profile',()=>{
 assert.equal(verifiedEmptyReplyOrigin(row(),'owner',now),true);
 for(const mutate of [(r:any)=>{r.originKind='legacy';},(r:any)=>{r.bootstrapDigest='b'.repeat(64);},(r:any)=>{delete r.provenance.emptyAccountProof;},(r:any)=>{r.provenance.emptyAccountProof.ownerId='foreign';},(r:any)=>{r.provenance.emptyAccountProof.legacySourceDigest='b'.repeat(64);},(r:any)=>{r.provenance.emptyAccountProof.accountState='imported';},(r:any)=>{r.provenance.emptyAccountProof.verifiedAt='2026-11-10T00:00:00Z';},(r:any)=>{r.provenance.emptyAccountProof.extra='not allowed';}]){const value=row();mutate(value);assert.equal(verifiedEmptyReplyOrigin(value,'owner',now),false);}
});
test('opaque recipient compatibility is exact owner digest, never a caller-provided chat ID or username',()=>{
 assert.equal(telegramOwnerRecipientRef('owner'),'owner:'+createHash('sha256').update(JSON.stringify('owner')).digest('hex').slice(0,40));assert.notEqual(telegramOwnerRecipientRef('owner'),telegramOwnerRecipientRef('other'));for(const owner of ['', 'bad\nowner'])assert.throws(()=>telegramOwnerRecipientRef(owner));
});
