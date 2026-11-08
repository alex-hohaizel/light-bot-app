import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramInbox,TELEGRAM_INBOX_BOT_ID,TELEGRAM_INBOX_SCHEMA_SQL,type TelegramInboxPool,type TelegramInboxAcceptResult} from '../../server/production/telegram-inbox.ts';
const secret='synthetic_inbox_secret',at='2026-11-08T19:00:00Z',botId=TELEGRAM_INBOX_BOT_ID;
const message=(update=1,patch:Record<string,any>={})=>({update_id:update,message:{message_id:50,date:1_794_161_000,from:{id:700001,is_bot:false,first_name:'PRIVATE NAME',username:'private_username'},chat:{id:700001,type:'private',first_name:'PRIVATE NAME'},text:'/start',...patch}});
const callback=(update=2,data='b1_ownsession',patch:Record<string,any>={})=>({update_id:update,callback_query:{id:'native-private-query',from:{id:700001,is_bot:false,first_name:'PRIVATE NAME'},message:{message_id:60,date:1_794_161_000,from:{id:Number(botId),is_bot:true},chat:{id:700001,type:'private'},text:'PRIVATE OLD CARD'},chat_instance:'private-chat-instance',data,...patch}});
const raw=(value:unknown)=>JSON.stringify(value);
class Port {
 rows=new Map<string,any>();control:any={controlEpoch:'7',writerMode:'canonical'};calls:string[]=[];connects=0;mode:'normal'|'saved'|'not_saved'='normal';releaseThrows=false;commitGate:(()=>Promise<void>)|null=null;
 pool:TelegramInboxPool={connect:async()=>{this.connects++;let tx:Map<string,any>|null=null;return {query:async(sql,values=[])=>{
  const q=sql.replace(/\s+/g,' ').trim();this.calls.push(q);const result=(rows:any[]=[],rowCount=rows.length)=>({rows:structuredClone(rows),rowCount});
  if(q==='begin isolation level read committed'){tx=structuredClone(this.rows);return result();}
  if(q==='commit'){await this.commitGate?.();const mode=this.mode;this.mode='normal';if(mode!=='not_saved')this.rows=tx!;tx=null;if(mode!=='normal')throw Error('PRIVATE_DB_FAILURE');return result();}
  if(q==='rollback'){tx=null;return result();}
  assert(tx);if(q.startsWith('select control_epoch'))return result(this.control?[this.control]:[]);
  if(q.startsWith('select pg_advisory_xact_lock'))return result();
  assert.equal(values[0],botId);
  if(q.startsWith('select bot_id as')){const row=tx.get(values[1]);return result(row?[row]:[]);}
  if(q.startsWith('insert into lba_production_telegram_inbox')){
   if(tx.has(values[1]))return result([],0);
   tx.set(values[1],{botId:values[0],updateId:values[1],payloadSha256:values[2],controlEpoch:values[3],disposition:values[4],eventKind:values[5],ignoredReason:values[6],privateInput:values[7]===null?null:JSON.parse(values[7]),receivedAt:values[8]});return result([],1);
  }
  throw Error('UNSUPPORTED_FIXTURE_QUERY');
 },release:()=>{if(this.releaseThrows){this.releaseThrows=false;throw Error('PRIVATE_RELEASE_ERROR');}}};}};
 create(patch:Record<string,any>={}){return createTelegramInbox({enabled:true,expectedBotId:botId,expectedControlEpoch:7,secret,pool:this.pool,now:()=>at,...patch});}
}
function committed(value:TelegramInboxAcceptResult){assert.equal(value.status,'committed');if(value.status!=='committed')throw Error('UNEXPECTED_TEST_RESULT');assert.equal(value.ack,true);return value;}
test('factory requires explicit bot/epoch/secret/pool, has no startup or DDL effects and remains disabled by default',async()=>{
 const p=new Port();p.create();assert.equal(p.connects,0);assert(!/\b(?:drop|truncate|insert|update|delete)\b/i.test(TELEGRAM_INBOX_SCHEMA_SQL));assert(!TELEGRAM_INBOX_SCHEMA_SQL.includes('create table if not exists lba_production_control'));
 for(const patch of [{expectedBotId:'other'},{expectedControlEpoch:0},{secret:'bad secret'},{secret:'x'.repeat(257)}])assert.throws(()=>p.create(patch),/INVALID_TELEGRAM_INBOX_OPTIONS/);
 const result=await p.create({enabled:undefined}).accept(secret,raw(message()));assert.deepEqual(result,{status:'rejected',ack:false,code:'TELEGRAM_INBOX_DISABLED'});assert.equal(p.connects,0);
});
test('secret verification always precedes parsing or connecting; headers are exact and never exported',async()=>{
 const p=new Port(),inbox=p.create();for(const header of [undefined,null,'wrong','',' '+secret,[secret],secret+', '+secret,'x'.repeat(10000)]){
  const result=await inbox.accept(header,'not JSON');assert.deepEqual(result,{status:'rejected',ack:false,code:'TELEGRAM_INBOX_SECRET_INVALID'});assert(!JSON.stringify(result).includes(secret));
 }assert.equal(p.connects,0);
});
test('bounded UTF-8/JSON shape, duplicate keys, nesting, unsafe numbers and multiple events reject before DB',async()=>{
 const p=new Port(),inbox=p.create();
 for(const invalid of ['{',raw([]),raw({update_id:1}),raw({update_id:0,message:{}}),raw({...message(),callback_query:{}}),raw({...message(),update_id:2**53}),
  '{"update_id":1,"update_id":2,"message":{}}','{"update_id":1,"updat\\u0065_id":2,"message":{}}',raw({update_id:1,constructor:{}}),Buffer.from([0xc3,0x28]),
  '{"update_id":1,"unknown":1e999}',raw({update_id:1,unknown:'\ud800'}),raw({update_id:1,unknown:Array.from({length:21},()=>1).reduce(v=>[v],[] as any)})]){
  const result=await inbox.accept(secret,invalid);assert.equal(result.ack,false);assert.notEqual(result.status,'committed');
 }assert.equal(p.connects,0);
 const limited=await p.create({maxBytes:8}).accept(secret,raw(message()));assert.deepEqual(limited,{status:'rejected',ack:false,code:'TELEGRAM_INBOX_PAYLOAD_LIMIT'});
});
test('accepted private message stores only native actor/chat/message/input facts, never guessed application owner or native display metadata',async()=>{
 const p=new Port(),result=committed(await p.create().accept(secret,Buffer.from(raw(message())))),row=p.rows.get('1');
 assert.deepEqual(row.privateInput,{version:'lba-telegram-private-input/1',botId,updateId:'1',actorTelegramId:'700001',chatId:'700001',messageId:50,input:{id:`tg:${botId}:1`,kind:'command',text:'/start'}});
 const publicValue=JSON.stringify(result);for(const forbidden of ['chatId','actorTelegramId','first_name','PRIVATE NAME','private_username','/start','payloadSha256',secret])assert(!publicValue.includes(forbidden));
 assert(!('ownerId'in row.privateInput));assert.equal(result.receipt.phase,'ingress_committed');
});
test('private actor and chat must be the same actual human numeric identity',async()=>{
 const p=new Port(),inbox=p.create();for(const patch of [{chat:{id:700002,type:'private'}},{from:{id:'700001',is_bot:false}},{from:{id:700001,is_bot:true}},{from:{id:Number(botId),is_bot:false},chat:{id:Number(botId),type:'private'}}]){
  const result=await inbox.accept(secret,raw(message(10,patch)));assert.equal(result.ack,false);assert.equal(result.status,'rejected');
 }assert.equal(p.connects,0);
});
test('callback verifies expected bot ID and native private actor, and preserves native query/data without inventing ownership',async()=>{
 const p=new Port(),inbox=p.create();committed(await inbox.accept(secret,raw(callback())));const stored=p.rows.get('2').privateInput;
 assert.equal(stored.callbackQueryId,'native-private-query');assert.equal(stored.input.callbackId,'b1_ownsession');assert.equal(stored.input.kind,'callback');assert.equal(stored.actorTelegramId,stored.chatId);
 for(const patch of [{message:{...callback().callback_query.message,from:{id:999,is_bot:true,username:'PowerUkraineBot'}}},{message:{...callback().callback_query.message,from:{id:Number(botId),is_bot:false}}}]){
  const result=await inbox.accept(secret,raw(callback(20,'data',patch)));assert.equal(result.status,'rejected');assert(!result.ack);if('code'in result)assert.equal(result.code,'TELEGRAM_INBOX_CALLBACK_BOT_MISMATCH');
 }
 assert.equal(p.rows.size,1);
});
test('callback_data has exact 1…64 UTF-8 byte bound; long IDs are rejected, not truncated',async()=>{
 const p=new Port(),inbox=p.create();let id=30;
 for(const value of ['x'.repeat(64),'я'.repeat(32)]){committed(await inbox.accept(secret,raw(callback(id++,value))));assert.equal(p.rows.get(String(id-1)).privateInput.input.callbackId,value);}
 for(const value of ['','x'.repeat(65),'я'.repeat(33)]){const result=await inbox.accept(secret,raw(callback(id++,value)));assert.equal(result.status,'rejected');}
 assert.equal(p.rows.size,2);
});
test('unsupported events are durably ignored without storing identities, body, captions or native query data',async()=>{
 const p=new Port(),inbox=p.create();const events=[{update_id:41,channel_post:{text:'PRIVATE UNSUPPORTED',chat:{id:98765,type:'channel'}}},message(42,{chat:{id:-77,type:'group'},text:'PRIVATE GROUP'}),message(43,{text:undefined,photo:[{file_id:'PRIVATE FILE'}]}),callback(44,'private-data',{message:undefined,inline_message_id:'PRIVATE INLINE'}),callback(45,'private-data',{message:{...callback().callback_query.message,date:0}})];
 for(const event of events){const result=committed(await inbox.accept(secret,raw(event)));assert.equal(result.receipt.disposition,'ignored');const stored=p.rows.get(String(event.update_id));assert.equal(stored.privateInput,null);assert.equal(stored.eventKind,'ignored');assert(!JSON.stringify(stored).includes('PRIVATE'));}
});
test('canonical key order/whitespace duplicates replay one receipt; any semantic native payload change conflicts',async()=>{
 const p=new Port(),inbox=p.create(),first=committed(await inbox.accept(secret,raw(message())));
 const reordered={message:{text:'/start',chat:{type:'private',first_name:'PRIVATE NAME',id:700001},from:{username:'private_username',first_name:'PRIVATE NAME',is_bot:false,id:700001},date:1794161000,message_id:50},update_id:1};
 const duplicate=committed(await inbox.accept(secret,JSON.stringify(reordered,null,2)));assert.equal(duplicate.replayed,true);assert.deepEqual(duplicate.receipt,first.receipt);
 for(const changed of [message(1,{text:'/pause'}),message(1,{from:{...message().message.from,first_name:'Changed name'}})]){
  const result=await inbox.accept(secret,raw(changed));assert.deepEqual(result,{status:'rejected',ack:false,code:'TELEGRAM_INBOX_UPDATE_CONFLICT'});
 }assert.equal(p.rows.size,1);assert.equal(p.rows.get('1').privateInput.input.text,'/start');
});
test('control missing/disabled/legacy/wrong epoch fail closed and never insert an update',async()=>{
 for(const control of [null,{controlEpoch:7,writerMode:'disabled'},{controlEpoch:7,writerMode:'legacy'},{controlEpoch:8,writerMode:'canonical'}]){
  const p=new Port();p.control=control;const result=await p.create().accept(secret,raw(message()));assert.equal(result.ack,false);assert.equal(p.rows.size,0);assert(!p.calls.some(q=>q.startsWith('insert ')));assert.equal(p.calls.at(-1),'rollback');
 }
});
test('no committed ACK escapes until COMMIT acknowledgement, and public receipt is reconstructed from closed fields',async()=>{
 const p=new Port();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});p.commitGate=()=>gate;
 let settled=false;const pending=p.create().accept(secret,raw(message())).then(result=>{settled=true;return result;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(p.rows.size,0);release();committed(await pending);assert.equal(p.rows.size,1);
});
test('saved/not-saved COMMIT uncertainty returns no ACK; exact receipt recovery distinguishes it without reaccepting or consuming',async()=>{
 for(const mode of ['saved','not_saved'] as const){const p=new Port(),inbox=p.create();p.mode=mode;
  assert.deepEqual(await inbox.accept(secret,raw(message())),{status:'unknown',ack:false,code:'TELEGRAM_INBOX_COMMIT_UNKNOWN'});
  const recovered=await inbox.recoverReceipt(secret,raw(message()));assert.equal(recovered.status,mode==='saved'?'committed':'missing');
  const retried=committed(await inbox.accept(secret,raw(message())));assert.equal(retried.replayed,mode==='saved');assert.equal(p.rows.size,1);
 }
});
test('release failure after successful commit remains unknown; later process instance recovers exact durable record',async()=>{
 const p=new Port(),inbox=p.create();p.releaseThrows=true;assert.deepEqual(await inbox.accept(secret,raw(message())),{status:'unknown',ack:false,code:'TELEGRAM_INBOX_COMMIT_UNKNOWN'});
 const restarted=p.create(),recovered=await restarted.recoverReceipt(secret,raw(message()));assert.equal(recovered.status,'committed');assert.equal(p.rows.size,1);
});
test('corrupt minimized private input cannot be acknowledged as durable valid work',async()=>{
 const p=new Port(),inbox=p.create();committed(await inbox.accept(secret,raw(message())));p.rows.get('1').privateInput.ownerId='FOREIGN_INJECTED_OWNER';
 const result=await inbox.recoverReceipt(secret,raw(message()));assert.deepEqual(result,{status:'rejected',ack:false,code:'TELEGRAM_INBOX_RECORD_INVALID'});assert(!JSON.stringify(result).includes('FOREIGN'));
});
test('invalid/backwards clock and missing schema/storage errors are safe, do not leak query values',async()=>{
 const p=new Port();assert.deepEqual(await p.create({now:()=> 'invalid'}).accept(secret,raw(message())),{status:'rejected',ack:false,code:'TELEGRAM_INBOX_CLOCK_INVALID'});assert.equal(p.connects,0);
 const broken=createTelegramInbox({enabled:true,expectedBotId:botId,expectedControlEpoch:7,secret,now:()=>at,pool:{connect:async()=>{throw Error(secret);}}});
 assert.deepEqual(await broken.accept(secret,raw(message())),{status:'unavailable',ack:false,code:'TELEGRAM_INBOX_STORAGE_UNAVAILABLE'});
 let now=at;const monotonic=p.create({now:()=>now});committed(await monotonic.accept(secret,raw(message())));const connected=p.connects;now='2026-11-08T18:59:59Z';
 assert.deepEqual(await monotonic.accept(secret,raw(message(100))),{status:'rejected',ack:false,code:'TELEGRAM_INBOX_CLOCK_INVALID'});assert.equal(p.connects,connected);
});
test('epoch rollover cannot silently reassign or ACK a durable prior-epoch event',async()=>{
 const p=new Port();committed(await p.create().accept(secret,raw(message())));p.control.controlEpoch=8;
 const next=p.create({expectedControlEpoch:8});
 for(const result of [await next.accept(secret,raw(message())),await next.recoverReceipt(secret,raw(message()))])assert.deepEqual(result,{status:'rejected',ack:false,code:'TELEGRAM_INBOX_CONTROL_EPOCH_CONFLICT'});
 assert.equal(p.rows.get('1').controlEpoch,7);committed(await next.accept(secret,raw(message(101))));assert.equal(p.rows.get('101').controlEpoch,8);
});
