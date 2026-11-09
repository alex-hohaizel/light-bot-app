import test from 'node:test';
import assert from 'node:assert/strict';
import {createBotState,handleBotInput,type BotState,type BotContext,type BotTurn,type CallbackAction,type AddressOption} from '../../shared/bot/engine.ts';
const namespace='yasno:25/902',at='2026-11-09T14:00:00Z',expires='2026-11-09T14:10:00Z';
const directory={id:'yasno-kyiv',namespace,operatorId:'dtek-kem',locality:'Київ',localityId:`source:${namespace}:locality:kyiv`,territoryId:`source:${namespace}`,territoryLabel:'ДТЕК Київські електромережі'};
const streetRef='11111111-1111-4111-8111-111111111111',houseRef='22222222-2222-4222-8222-222222222222';
function context():BotContext{return {actorId:'qa-provider',now:at,addresses:[],plans:[],addressCatalogStatus:'unavailable',providerDirectory:[structuredClone(directory)],operatorLabels:{'dtek-kem':'ДТЕК Київські електромережі'}};}
function option():AddressOption{return {id:'provider-option-44360',address:{id:'provisional:yasno:25/902:street:985:house:44360',label:'Обрана адреса',territoryId:directory.territoryId,localityId:directory.localityId,locality:'Київ',street:'дорога Кільцева',streetId:`source:${namespace}:street:985`,house:{number:'1',literal:'1'},aliases:[]},binding:{addressId:'provisional:yasno:25/902:street:985:house:44360',operatorId:'dtek-kem',namespace,targetId:'25.1',kind:'operator_group',revisionId:'candidate-r1',status:'needs_confirmation',verifiedAt:null,effectiveFrom:null,effectiveUntil:null},territoryLabel:directory.territoryLabel};}
function streets(c:BotContext){c.providerStreets={directoryId:directory.id,state:'available',query:'Кільцева',snapshotId:streetRef,expiresAt:expires,items:[{id:125,value:'вул. Велика Кільцева'},{id:985,value:'дорога Кільцева'}]};}
function houses(c:BotContext,resolved=false){c.providerHouses={directoryId:directory.id,state:'available',query:'1',streetId:985,streetValue:'дорога Кільцева',streetSnapshotId:streetRef,houseSnapshotId:houseRef,expiresAt:expires,items:[{id:44360,value:'1',...(resolved?{optionId:option().id}:{})},{id:44361,value:'1А'},{id:44374,value:'20/1А'}]};if(resolved)c.addresses=[option()];}
function harness(c=context(),initial?:BotState){
 let state=initial??createBotState({ownerId:c.actorId,sessionId:'qa-provider-session'}),last:BotTurn,counter=0;
 const step=(input:Parameters<typeof handleBotInput>[1])=>{last=handleBotInput(state,input,c);state=last.state;return last;};
 const text=(value:string)=>step({id:'input-'+ ++counter,kind:value.startsWith('/')?'command':'text',text:value});
 const click=(kind:CallbackAction['kind'],where:(v:CallbackAction)=>boolean=()=>true)=>{
  const b=last.messages.flatMap(m=>m.buttons).find(b=>state.callbacks[b.callbackId]?.action.kind===kind&&where(state.callbacks[b.callbackId].action));assert(b,'missing callback '+kind);return step({id:'input-'+ ++counter,kind:'callback',callbackId:b.callbackId});
 };
 const chooseDirectory=()=>click('locality',a=>'value'in a&&a.value==='provider:'+directory.id);
 const toHouse=()=>{text('/add');chooseDirectory();streets(c);text('Кільцева');click('provider_street',a=>'value'in a&&JSON.parse(a.value as string)[1]===985);};
 const toConfirm=()=>{toHouse();houses(c);text('1');houses(c,true);click('provider_house',a=>'value'in a&&JSON.parse(a.value as string)[3]===44360);};
 return {c,get state(){return state;},get last(){return last;},text,step,click,chooseDirectory,toHouse,toConfirm};
}
test('empty global candidate cache still offers actual provider scope and full exact street→house→explicit-confirm workflow',()=>{
 const h=harness();h.toConfirm();assert.equal(h.state.stage,'address_confirm');assert.equal(h.state.profile.locations.length,0);
 assert(h.last.messages.some(m=>m.text.includes('Кільцева')&&m.text.includes('ДТЕК')));
 h.click('confirm_address');assert.equal(h.state.profile.locations.length,1);assert.equal(h.state.profile.locations[0].binding.targetId,'25.1');
 assert.equal(h.state.profile.locations[0].binding.status,'needs_confirmation');assert.equal(h.state.profile.locations[0].notifications,false);assert.equal(h.state.profile.preferences.optedIn,false);
 assert(h.last.actions.some(a=>a.type==='persist_profile'));assert(!h.last.messages.flatMap(m=>m.buttons).some(b=>h.state.callbacks[b.callbackId]?.action.kind==='subscription'));
});
test('live lookup scope stays distinguishable from same-named legacy catalog locality without merging identities',()=>{
 const c=context(),legacy=option();legacy.address.territoryId='legacy-kyiv';legacy.address.localityId='legacy-kyiv';c.addresses=[legacy];c.addressCatalogStatus='ready';
 const h=harness(c);h.text('/add');const choices=h.last.messages.flatMap(m=>m.buttons).filter(b=>h.state.callbacks[b.callbackId].action.kind==='locality');
 assert.equal(choices.length,2);assert.equal(new Set(choices.map(b=>b.label)).size,2);assert(choices.some(b=>b.label.includes('пошук адреси')));
});
test('exact typed house may enter confirmation only when trusted preflight resolved that exact raw house',()=>{
 const h=harness();h.toHouse();houses(h.c,true);h.text('1');assert.equal(h.state.stage,'address_confirm');assert.equal(h.state.profile.locations.length,0);
 const g=harness();g.toHouse();houses(g.c);g.text('1');assert.equal(g.state.stage,'house');assert.equal(g.state.profile.locations.length,0);
 assert(g.last.messages.flatMap(m=>m.buttons).some(b=>g.state.callbacks[b.callbackId].action.kind==='provider_house'));
});
test('provider streets and houses paginate three choices, do not expose source IDs as user identity, and retain explicit tuple references',()=>{
 const h=harness();h.text('/add');h.chooseDirectory();h.c.providerStreets={directoryId:directory.id,state:'available',query:'Тестова',snapshotId:streetRef,expiresAt:expires,items:Array.from({length:8},(_,i)=>({id:900+i,value:'вул. Тестова '+(i+1)}))};h.text('Тестова');
 const choices=()=>h.last.messages.flatMap(m=>m.buttons).filter(b=>h.state.callbacks[b.callbackId].action.kind==='provider_street');assert.equal(choices().length,3);
 h.click('page',a=>a.kind==='page'&&a.scope==='provider_street'&&a.value===1);assert.equal(choices().length,3);assert(h.last.messages.some(m=>m.text.includes('Сторінка 2 з 3')));
 const g=harness();g.toHouse();houses(g.c);g.c.providerHouses!.items=Array.from({length:8},(_,i)=>({id:44000+i,value:String(10+i)}));g.text('1');
 assert.equal(g.last.messages.flatMap(m=>m.buttons).filter(b=>g.state.callbacks[b.callbackId].action.kind==='provider_house').length,3);
 g.click('page',a=>a.kind==='page'&&a.scope==='provider_house'&&a.value===1);assert(g.last.messages.some(m=>m.text.includes('Сторінка 2 з 3')));
});
test('provider snapshot expiry and replaced capture references reject still-live native callbacks without changing profile',()=>{
 for(const change of ['expiry','snapshot','directory'] as const){const h=harness();h.text('/add');h.chooseDirectory();streets(h.c);h.text('Кільцева');
  const button=h.last.messages.flatMap(m=>m.buttons).find(b=>h.state.callbacks[b.callbackId].action.kind==='provider_street'&&JSON.parse((h.state.callbacks[b.callbackId].action as any).value)[1]===985)!;
  if(change==='expiry')h.c.now=expires;if(change==='snapshot')h.c.providerStreets!.snapshotId='different';if(change==='directory')h.c.providerStreets!.directoryId='foreign';
  h.step({id:'stale-'+change,kind:'callback',callbackId:button.callbackId});assert.equal(h.state.profile.locations.length,0);assert.notEqual(h.state.stage,'house');
 }
});
test('provider house callback cannot cross street/capture/namespace or choose an unresolved option',()=>{
 for(const change of ['street','capture','namespace','missingOption'] as const){const h=harness();h.toHouse();houses(h.c);h.text('1');
  const b=h.last.messages.flatMap(m=>m.buttons).find(b=>h.state.callbacks[b.callbackId].action.kind==='provider_house'&&JSON.parse((h.state.callbacks[b.callbackId].action as any).value)[3]===44360)!;
  houses(h.c,true);if(change==='street')h.c.providerHouses!.streetId=125;if(change==='capture')h.c.providerHouses!.houseSnapshotId='other';if(change==='namespace')h.c.addresses[0].binding.namespace='foreign';if(change==='missingOption')delete h.c.providerHouses!.items[0].optionId;
  h.step({id:'foreign-'+change,kind:'callback',callbackId:b.callbackId});assert.equal(h.state.profile.locations.length,0);assert.notEqual(h.state.stage,'address_confirm');
 }
});
test('consent is tied to full current option and snapshot TTL at final confirmation, not only source IDs/revision',()=>{
 for(const change of ['metadata','expiry'] as const){const h=harness();h.toConfirm();if(change==='metadata')h.c.addresses[0].address.placeNames=['Нова назва'];else h.c.now=expires;
  h.click('confirm_address');assert.equal(h.state.profile.locations.length,0);assert(h.last.messages.some(m=>m.text.includes('змінилися')||m.text.includes('застаріли')||m.text.includes('Перевірте')));
 }
});
test('expiry of the parent street capture blocks confirmation while the later house capture is still fresh',()=>{
 const h=harness();h.toConfirm();h.c.providerStreets!.expiresAt='2026-11-09T14:01:00Z';h.c.now='2026-11-09T14:01:00Z';
 assert(Date.parse(h.c.providerHouses!.expiresAt!)>Date.parse(h.c.now));h.click('confirm_address');assert.equal(h.state.profile.locations.length,0);
});
test('query mismatch, unknown/empty/failed provider result cannot reuse old house options as a new exact match',()=>{
 for(const state of ['available','loading','deferred','unavailable','stale'] as const){const h=harness();h.toHouse();houses(h.c,true);h.c.providerHouses!.state=state;h.text('2');assert.notEqual(h.state.stage,'address_confirm');assert.equal(h.state.profile.locations.length,0);assert(!h.last.actions.some(a=>a.type==='persist_profile'));}
 const empty=harness();empty.toHouse();houses(empty.c);empty.c.providerHouses!.items=[];empty.text('1');assert(empty.last.messages.some(m=>m.text.includes('не повернув будинків')));
});
test('Latin lookalike house input never silently confirms Cyrillic house or a neighbouring result',()=>{
 const h=harness();h.toHouse();houses(h.c,true);h.c.providerHouses!.query='1A';h.c.providerHouses!.items=[{id:44361,value:'1А',optionId:option().id}];h.c.addresses[0].address.house={number:'1',letter:'А',literal:'1А'};h.text('1A');assert.equal(h.state.stage,'house');assert.equal(h.state.profile.locations.length,0);
 assert(h.last.messages.flatMap(m=>m.buttons).some(b=>b.label.includes('1А')));
});
test('duplicate provider IDs or indistinguishable source names do not manufacture a pickable address',()=>{
 const h=harness();h.text('/add');h.chooseDirectory();streets(h.c);h.c.providerStreets!.items.push({...h.c.providerStreets!.items[1],id:986});h.text('Кільцева');
 assert(!h.last.messages.flatMap(m=>m.buttons).some(b=>h.state.callbacks[b.callbackId].action.kind==='provider_street'&&JSON.parse((h.state.callbacks[b.callbackId].action as any).value)[1]===985));
 assert(h.last.messages.some(m=>m.text.includes('однакові назви')));
 const g=harness();g.toHouse();houses(g.c);g.c.providerHouses!.items=[{id:1,value:'1'},{id:2,value:'1'}];g.text('1');assert(!g.last.messages.flatMap(m=>m.buttons).some(b=>g.state.callbacks[b.callbackId].action.kind==='provider_house'));
});
test('saved personal profile and label remain unchanged through replacement lookup until explicit confirmation',()=>{
 const c=context(),initial=createBotState({ownerId:c.actorId,sessionId:'qa-edit-session'}),old=option();old.address.id='old-address';old.binding.addressId=old.address.id;
 initial.profile.locations=[{address:{...old.address,label:'Батьки'},binding:old.binding,paused:true,notifications:false}];initial.profile.primaryAddressId=old.address.id;initial.currentAddressId=old.address.id;
 const original=structuredClone(initial.profile),h=harness(c,initial);h.text('/location_manage');h.click('location_action',a=>a.kind==='location_action'&&a.value==='edit');h.chooseDirectory();streets(c);h.text('Кільцева');h.click('provider_street',a=>'value'in a&&JSON.parse(a.value as string)[1]===985);houses(c);h.text('1');houses(c,true);h.click('provider_house',a=>'value'in a&&JSON.parse(a.value as string)[3]===44360);
 assert.deepEqual(h.state.profile,original);h.click('confirm_address');assert.equal(h.state.profile.locations.length,1);assert.equal(h.state.profile.locations[0].address.label,'Батьки');assert.equal(h.state.profile.locations[0].paused,true);assert.equal(h.state.profile.primaryAddressId,option().address.id);
});
test('same provider callback replay and foreign actor keep ordinary engine owner/revision guards',()=>{
 const h=harness();h.text('/add');h.chooseDirectory();streets(h.c);h.text('Кільцева');const b=h.last.messages.flatMap(m=>m.buttons).find(b=>h.state.callbacks[b.callbackId].action.kind==='provider_street')!;
 h.c.actorId='foreign';const r=h.step({id:'foreign-callback',kind:'callback',callbackId:b.callbackId});assert.equal(r.rejected,'foreign_actor');assert.equal(h.state.profile.locations.length,0);
 const g=harness();g.text('/add');g.chooseDirectory();streets(g.c);g.text('Кільцева');const chosen=g.last.messages.flatMap(m=>m.buttons).find(b=>g.state.callbacks[b.callbackId].action.kind==='provider_street')!;
 const input={id:'provider-same-input',kind:'callback' as const,callbackId:chosen.callbackId};g.step(input);const revision=g.state.revision;assert.equal(g.step(input).duplicate,true);assert.equal(g.state.revision,revision);
 assert.equal(g.step({...input,id:'provider-old-callback-new-input'}).rejected,'stale_callback');assert.equal(g.state.profile.locations.length,0);
});
