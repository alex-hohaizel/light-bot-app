import {createAddressCatalog,type AddressCandidatesSnapshot} from './address-catalog.ts';
import {createOdesaAddressCatalog} from './odesa-address-catalog.ts';

/** One composition for App, Bot and issuer. Construction is inert. The caller's
 * explicit operator flag does not create a source/binding/delivery admission.
 * Providers degrade independently; an unavailable provider cannot remove fresh
 * facts of another provider or resurrect its own expired facts.
 */
export function createProviderAddressCatalog(input:Parameters<typeof createAddressCatalog>[0]&{operatorLookupEnabled?:boolean}){
 const legacy=createAddressCatalog(input),operator=createOdesaAddressCatalog({enabled:input.enabled===true&&input.operatorLookupEnabled===true,
  expectedControlEpoch:input.expectedControlEpoch,pool:input.pool,now:input.now});
 return combineAddressCatalogs(legacy,operator);
}
/** Trusted composition seam; it validates no provider facts and supplies no IO. */
export function combineAddressCatalogs(legacy:ReturnType<typeof createAddressCatalog>,operator:ReturnType<typeof createOdesaAddressCatalog>){
 async function readCandidates():Promise<AddressCandidatesSnapshot>{
  const [kyiv,odesa]=await Promise.all([legacy.readCandidates(),operator.readCandidates()]);
  const available=kyiv.state==='available'||odesa.state==='available';
  const disabled=kyiv.state==='disabled'&&odesa.state==='disabled';
  const options=[...(kyiv.state==='available'?kyiv.options:[]),...(odesa.state==='available'?odesa.options:[])];
  // Distinct group options deliberately share an address ID, never an option ID.
  if(new Set(options.map(v=>v.id)).size!==options.length)return {state:'unavailable',code:'ADDRESS_SCHEMA_REJECTED',options:[],observations:[],addressBindingVerified:false,deliveryEligible:false};
  return {state:available?'available':disabled?'disabled':'unavailable',...(!available&&kyiv.code?{code:kyiv.code}:{}),options,
   observations:[...kyiv.observations,...odesa.observations],operatorNotices:odesa.state==='available'?odesa.operatorNotices:[],
   providerStates:[{namespace:'yasno:25/902',state:kyiv.state,...(kyiv.code?{code:kyiv.code}:{})},
    {namespace:'dtek:oem',state:odesa.state,...('code'in odesa?{code:odesa.code}:{})}],
   addressBindingVerified:false,deliveryEligible:false};
 }
 return Object.freeze({...legacy,operator,readCandidates});
}
