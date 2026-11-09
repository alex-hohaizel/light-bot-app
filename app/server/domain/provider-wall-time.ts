import {calendarDate,dayBounds,localParts,wallMinuteInstant} from '../../shared/schedule-core.ts';

/** Resolve a publisher wall minute with existing Europe/Kyiv IANA rules.
 * No offset is assumed and no fold is selected. The ordinary-day core path
 * stays intact; transition days require exactly one verified UTC candidate. */
export function uniqueProviderWallMinuteInstant(date:string,minute:number):string {
 calendarDate(date);
 if(!Number.isInteger(minute)||minute<0||minute>=1440)throw Error('INVALID_PROVIDER_WALL_MINUTE');
 // Preserve the exact ordinary-day core path before trying any DST resolver.
 try{return wallMinuteInstant(date,minute);}catch(error){if(dayBounds(date).minutes===1440)throw error;}
 const bounds=dayBounds(date);
 const offsets=new Set<number>(),instants=new Set<number>();
 // Include the instant before local midnight so a midnight fold cannot hide
 // its earlier offset. Edges supply actual IANA offsets on transition days.
 for(const epoch of [bounds.start-60000,bounds.start,bounds.end-60000]){
  const local=localParts(epoch),offset=(Date.parse(`${local.date}T${local.time}:00Z`)-epoch)/60000;
  if(!Number.isInteger(offset)||Math.abs(offset)>1439)throw Error('UNSUPPORTED_PROVIDER_OFFSET');
  offsets.add(offset);
 }
 for(const minutes of offsets){
  const absolute=Math.abs(minutes),offset=`${minutes<0?'-':'+'}${String(Math.floor(absolute/60)).padStart(2,'0')}:${String(absolute%60).padStart(2,'0')}`;
  try{instants.add(Date.parse(wallMinuteInstant(date,minute,offset)));}catch{/* This observed offset does not represent this wall minute. */}
 }
 if(instants.size!==1)throw Error('AMBIGUOUS_OR_NONEXISTENT_PROVIDER_WALL_MINUTE');
 return new Date([...instants][0]).toISOString();
}
