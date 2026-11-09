import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeHourMatrix,VN_PRODUCER_CONTRACT} from '../../server/domain/hour-matrix-adapter.ts';
import {normalizeYasnoRaw} from '../../server/domain/yasno-adapter.ts';
const evidence=new URL('../../../docs/light-bot-app/release-v8/address-data-integration/source/',import.meta.url);
const research=new URL('../../../docs/light-bot-app/release-v8/source-research-2026-11-08/root/captures/',import.meta.url);
const read=(url:URL)=>readFileSync(url,'utf8'),hash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const vn=read(new URL('vinnytsia-mirror-comparison.bin',research)),dnem=read(new URL('yasno-dnem.bin',research));
const observedAt='2026-11-08T20:40:00Z';
const base=(raw:string,id:string)=>({addressId:'unbound:technical-test',addressLabel:'Технічна група',localityLabel:'Тест публічного джерела',
 serviceDate:'2026-11-08',observedAt,freshness:'current' as const,synthetic:false,
 source:{id,name:'Captured public source',url:null,revision:hash(raw),accessCost:0 as const,verifiedLevel:'schedule' as const}});
const vnContext=(raw=vn)=>({...base(raw,'voe-mirror-vn-progr'),namespace:'voe:vn-progr' as const,operatorId:'vinnytsia-oe',targetId:'GPV2.2'});
const dnContext=(raw=dnem)=>({...base(raw,'yasno-dnem'),namespace:'yasno:3/301' as const,operatorId:'dtek-dnem',targetId:'1.1'});
const change=(raw:string,mutate:(v:any)=>void)=>{const value=JSON.parse(raw);mutate(value);return JSON.stringify(value);};

test('actual8Nov VN1.0.0 first decodes the active producer first half, retains source identity and unverified address/delivery',()=>{
 const payload=JSON.parse(vn);assert.equal(payload.meta.schemaVersion,'1.0.0');assert.equal(payload.fact.data[String(payload.fact.today)]['GPV2.2']['10'],'first');
 const view=normalizeHourMatrix(vn,vnContext());assert.deepEqual(view.intervals.map(i=>[i.startLocal,i.endLocal]),[['02:00','04:00'],['08:00','09:30']]);
 assert.equal(view.source.id,'voe-mirror-vn-progr');assert.equal(view.source.revision,hash(vn));assert.equal(view.deliveryEligible,false);assert.equal(view.namespace,'voe:vinnytsia');assert.equal(view.source.verifiedLevel,'schedule');
 assert.equal(VN_PRODUCER_CONTRACT.independentPrimaryAccuracyVerified,false);assert.match(view.notice??'',/не підтверджені/);
 const latest=read(new URL('vn-data-48580.json',evidence));assert.equal(normalizeHourMatrix(latest,vnContext(latest)).intervals.at(-1)?.endLocal,'09:30');
});
test('VN second is a separate second-half rule; source-specific version/enum boundaries cannot be borrowed by Olnet',()=>{
 const second=change(vn,v=>{v.fact.data[String(v.fact.today)]['GPV2.2']['10']='second';});
 assert.deepEqual(normalizeHourMatrix(second,vnContext(second)).intervals.map(i=>[i.startLocal,i.endLocal]),[['02:00','04:00'],['08:00','09:00'],['09:30','10:00']]);
 for(const mutate of [(v:any)=>{v.meta.schemaVersion='2.0.0';},(v:any)=>{v.meta.schemaVersion=1;},(v:any)=>{delete v.meta;},(v:any)=>{v.fact.data[String(v.fact.today)]['GPV6.2']['24']='maybe';}]){
  const raw=change(vn,mutate);assert.throws(()=>normalizeHourMatrix(raw,vnContext(raw)),/SCHEMA|ENUM/);
 }
 assert.throws(()=>normalizeHourMatrix(vn,{...vnContext(),namespace:'voe:olnet93',source:{...vnContext().source,id:'voe-mirror-olnet93'}}),/ENUM/);
 const allHalf=change(vn,v=>{for(const g of Object.values(v.fact.data[String(v.fact.today)]) as any[])for(const k of Object.keys(g))g[k]='yes';v.fact.data[String(v.fact.today)]['GPV2.2']['10']='first';});
 const view=normalizeHourMatrix(allHalf,vnContext(allHalf));assert.equal(view.status,'published');assert.equal(view.dayCoverage,'complete');assert.equal(view.intervals.length,1);
});
test('pinned workflow calls captured producer and renderers; only extracted pure functions/branches execute in fixture proof',()=>{
 const workflow=read(new URL('vn-workflow.txt',evidence));assert.match(workflow,/python scripts\/parser\.py/);assert.match(workflow,/python scripts\/render_png\.py/);assert.match(workflow,/python scripts\/render_png_all_today\.py/);
 const program=String.raw`
import ast,re,json,sys
from pathlib import Path
parser=ast.parse(Path(sys.argv[1]).read_text())
names={'parse_time_slot','round_minutes_to_half_hour','hour_to_slot','parse_html_schedule'}
functions=[n for n in parser.body if isinstance(n,ast.FunctionDef) and n.name in names]
assert len(functions)==4
class Slot:
 def __init__(self,classes,text):self.classes=classes;self.text=text
 def get(self,key,default=None):return self.classes if key=='class' else default
 def select_one(self,selector):assert selector=='.bz-schedule-slot__time';return self
 def get_text(self,strip=False):return self.text.strip() if strip else self.text
class Soup:
 def __init__(self,html,parser):
  assert parser=='html.parser'
  self.slots=[Slot(c.split(),t) for c,t in re.findall(r'<div class="([^"]+)"><span class="bz-schedule-slot__time">([^<]+)</span></div>',html)]
 def select(self,selector):assert selector=='div.bz-schedule-slot';return self.slots
env={'re':re,'BeautifulSoup':Soup,'__builtins__':{'str':str,'range':range,'tuple':tuple,'map':map,'int':int,'enumerate':enumerate}}
exec(compile(ast.Module(body=functions,type_ignores=[]),'pinned_pure_functions','exec'),env)
def run(text):return env['parse_html_schedule']('<div class="bz-schedule-slot bz-schedule-slot--off"><span class="bz-schedule-slot__time">'+text+'</span></div>')
ending=run('08:00 - 09:30');starting=run('09:30 - 10:00')
assert ending['9']=='no' and ending['10']=='first'
assert starting['10']=='second'
draws={}
for filename in sys.argv[2:]:
 source=ast.parse(Path(filename).read_text());result={}
 for state in ['first','second']:
  nodes=[n for n in ast.walk(source) if isinstance(n,ast.If) and isinstance(n.test,ast.Compare) and isinstance(n.test.left,ast.Name) and n.test.left.id=='state' and len(n.test.comparators)==1 and isinstance(n.test.comparators[0],ast.Constant) and n.test.comparators[0].value==state]
  positions=[]
  for n in nodes:
   calls=[c for line in n.body for c in ast.walk(line) if isinstance(c,ast.Call) and isinstance(c.func,ast.Name) and c.func.id=='Rectangle']
   assert len(calls)==1
   expression=ast.Expression(calls[0].args[0]);position=eval(compile(expression,'rectangle_coordinate','eval'),{'__builtins__':{}},{'x':0,'y_pos':0,'cell_w':1})
   positions.append(position[0])
  assert positions and all(x==(0 if state=='first' else .5) for x in positions)
  result[state]=positions
 draws[Path(filename).name]=result
print(json.dumps({'ending0930':ending['10'],'starting0930':starting['10'],'draws':draws,'executedNetwork':False,'executedImportsFromPublisher':False}))
`;
 const result=JSON.parse(execFileSync('python3',['-c',program,...['vn-parser.txt','vn-render-png.txt','vn-render-all-today.txt'].map(name=>fileURLToPath(new URL(name,evidence)))],{encoding:'utf8',timeout:5000,maxBuffer:65536,env:{PATH:process.env.PATH??'/usr/bin:/bin'}}));
 assert.equal(result.ending0930,'first');assert.equal(result.starting0930,'second');assert.equal(result.executedNetwork,false);assert.equal(result.executedImportsFromPublisher,false);
 // The README is preserved as conflicting evidence, never selected as oracle.
 assert.match(read(new URL('vn-readme.txt',evidence)),/другу половину часу/);
});
test('actual12-group DnEM8Nov EmergencyShutdowns remains emergency with no intervals for both days',()=>{
 const payload=JSON.parse(dnem);assert.equal(Object.keys(payload).length,12);
 for(const targetId of Object.keys(payload))for(const day of ['today','tomorrow'] as const){
  const view=normalizeYasnoRaw(dnem,day,{...dnContext(),targetId,serviceDate:day==='today'?'2026-11-08':'2026-11-09'});
  assert.equal(view.status,'emergency');assert.equal(view.dayCoverage,'none');assert.deepEqual(view.intervals,[]);assert.equal(view.deliveryEligible,false);assert.equal(view.publishedAt,'2026-11-08T08:39:55+00:00');assert.equal(view.source.revision,hash(dnem));
 }
 const stale=normalizeYasnoRaw(dnem,'today',{...dnContext(),freshness:'stale'});assert.equal(stale.status,'stale');assert.equal(stale.dayCoverage,'none');assert.equal(stale.intervals.length,0);
});
test('emergency conflicts, missing/wrong slots, unknown day status and wrong source/date/hash remain rejected',()=>{
 for(const slots of [null,undefined,'',{},[{start:0,end:1440,type:'NotPlanned'}],[{start:0,end:30,type:'Definite'}]]){
  const raw=change(dnem,v=>{v['1.1'].today.slots=slots;});assert.throws(()=>normalizeYasnoRaw(raw,'today',dnContext(raw)),/EMERGENCY_DAY_HAS_UNEXPECTED_SLOTS/);
 }
 for(const status of ['Emergency','emergencyshutdowns','NoOutages',null,{}]){const raw=change(dnem,v=>{v['1.1'].today.status=status;});assert.throws(()=>normalizeYasnoRaw(raw,'today',dnContext(raw)),/UNKNOWN_PROVIDER_DAY_STATUS/);}
 const date=change(dnem,v=>{v['1.1'].today.date='2026-11-08T00:00:00Z';});assert.throws(()=>normalizeYasnoRaw(date,'today',dnContext(date)),/OFFSET/);
 const future=change(dnem,v=>{v['1.1'].updatedOn='2026-11-09T12:00:00Z';});assert.throws(()=>normalizeYasnoRaw(future,'today',dnContext(future)),/PUBLICATION_AFTER/);
 assert.throws(()=>normalizeYasnoRaw(dnem+' ','today',dnContext()),/HASH/);assert.throws(()=>normalizeYasnoRaw(dnem,'today',{...dnContext(),operatorId:'cek'}),/NAMESPACE/);
});
