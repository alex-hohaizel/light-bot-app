import test from 'node:test';
import assert from 'node:assert/strict';
import {createBotState,handleBotInput} from '../../shared/bot/engine.ts';
import {createDemoContext} from '../../shared/bot/fixtures.ts';
import {addressOptionFingerprint} from '../../shared/address-selection.ts';
import {applyProfileMutation} from '../../server/domain/profile-service.ts';
import type {AddressOption,BotTurn} from '../../shared/bot/types.ts';

function harness(){
 let state=createBotState(),context=createDemoContext(),n=0,turn:BotTurn;
 const send=(text:string)=>{turn=handleBotInput(state,{id:`address-case-${++n}`,kind:text.startsWith('/')?'command':'text',text},context);state=turn.state;return turn;};
 const click=(label:string)=>{const b=turn.messages.flatMap(m=>m.buttons).find(b=>b.label===label);assert.ok(b,`Missing ${label}`);turn=handleBotInput(state,{id:`address-case-${++n}`,kind:'callback',callbackId:b.callbackId},context);state=turn.state;return turn;};
 const start=()=>{send('/add');click('Вінниця · Вінницька область · тестовий каталог');send('Тестова');click('Тестова');};
 return {send,click,start,get state(){return state;},get context(){return context;},get turn(){return turn;}};
}
const text=(t:BotTurn)=>t.messages.map(m=>m.text).join('\n');

test('same option/binding revision with changed address metadata requires fresh confirmation in both channels',()=>{
 const changes:Array<(o:AddressOption)=>void>=[o=>{o.address.locality='Інше місто';},o=>{o.address.street='Інша вулиця';},o=>{o.address.house.literal='12Б';},o=>{o.connectionLabel='Інше підключення';},o=>{o.address.localityId='another-source-locality';},o=>{o.address.streetId='another-street-id';},o=>{o.address.placeNames=['Новий об’єкт'];},o=>{o.address.objectKind='commercial';}];
 for(const change of changes){
  const h=harness();h.start();h.send('12А');const option=h.context.addresses[0],fingerprint=addressOptionFingerprint(option),before=structuredClone(h.state.profile);
  change(option);assert.notEqual(addressOptionFingerprint(option),fingerprint);
  const request={id:'app-address-confirm',expectedSessionId:h.state.sessionId,expectedRevision:h.state.revision,mutation:{kind:'add' as const,optionId:option.id,bindingRevisionId:option.binding.revisionId,selectionFingerprint:fingerprint,label:'Дім',confirmed:true as const}};
  assert.throws(()=>applyProfileMutation(h.state,request,h.context.addresses),/PROFILE_SELECTION_CHANGED/);
  const result=h.click('Зберегти адресу');assert.deepEqual(h.state.profile,before);assert.match(text(result),/Дані адреси змінилися/);assert.equal(result.actions.length,0);
 }
});
test('Latin house lookalike needs explicit correction; invalid invisible input preserves the draft',()=>{
 const h=harness();h.start();const initial=structuredClone(h.state.profile);h.send('12A');assert.equal(h.state.stage,'house');assert.deepEqual(h.state.profile,initial);
 const suggestion=h.turn.messages.flatMap(m=>m.buttons).find(b=>b.label.includes('12А'));assert.ok(suggestion);h.click(suggestion.label);
 assert.equal(h.state.stage,'address_confirm');assert.equal(h.state.profile.locations.length,0);h.click('Назад');const draft=structuredClone(h.state.draft);
 h.send('12\u202eА');assert.deepEqual(h.state.draft,draft);assert.match(text(h.turn),/видимими літерами|символ/);assert.deepEqual(h.state.profile,initial);
});
test('public object lookup preserves all supplies and asks an explicit connection choice',()=>{
 const h=harness(),base=h.context.addresses.find(o=>o.address.house.literal==='12/1')!;
 base.address.placeNames=['ТЦ Публічний'];base.address.objectKind='commercial';base.connectionLabel='Перший ввід';
 const second=structuredClone(base);second.id='public-second-option';second.address.id='public-second-address';second.binding.addressId=second.address.id;second.binding.targetId='public:second';second.connectionLabel='Другий ввід';h.context.addresses.push(second);
 h.send('/add');h.click('Вінниця · Вінницька область · тестовий каталог');h.send('Публічний');const place=h.turn.messages.flatMap(m=>m.buttons).find(b=>b.label.includes('ТЦ Публічний'));assert.ok(place);h.click(place.label);
 assert.equal(h.state.stage,'connection');assert.equal(h.state.profile.locations.length,0);h.click('Другий ввід');h.click('Зберегти адресу');assert.equal(h.state.profile.locations[0].binding.targetId,'public:second');
});
test('selection fingerprint ignores personal labels and includes every source identity and connection',()=>{
 const option=createDemoContext().addresses[0],before=addressOptionFingerprint(option);option.address.label='Власна назва';assert.equal(addressOptionFingerprint(option),before);
 for(const mutate of [(o:AddressOption)=>o.address.aliases.push('Історична назва'),(o:AddressOption)=>{o.address.house.building='2';},(o:AddressOption)=>{o.binding.operatorId='another-operator';}]){const next=structuredClone(option);mutate(next);assert.notEqual(addressOptionFingerprint(next),before);}
});
test('an unavailable/loading catalog cannot save cached selections or claim a missing house; navigation and draft survive',()=>{
 for(const status of ['loading','unavailable'] as const){
  const h=harness();h.start();h.send('12А');const profile=structuredClone(h.state.profile),draft=structuredClone(h.state.draft);h.context.addressCatalogStatus=status;
  const blocked=h.click('Зберегти адресу');assert.deepEqual(h.state.profile,profile);assert.deepEqual(h.state.draft,draft);assert.match(text(blocked),/довідник адрес/);assert.equal(blocked.actions.length,0);
  h.send('/back');assert.equal(h.state.stage,'house');h.context.addresses=[];const absent=h.send('12А');assert.match(text(absent),/довідник адрес/);assert.doesNotMatch(text(absent),/немає підтвердженого збігу/);
  h.send('/cancel');assert.equal(h.state.stage,'home');assert.notEqual(h.state.draft,null);assert.deepEqual(h.state.profile,profile);
  h.send('/add');assert.equal(h.state.stage,'locality');assert.match(text(h.turn),/довідник адрес/);
 }
});
