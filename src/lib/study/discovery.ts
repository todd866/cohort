import {firstReviewRemaining,FIRST_REVIEW_WINDOW_MS,FIRST_REVIEW_LIMIT} from './first-review-highlights';
import {parseCheckIns} from '@/lib/check-ins/policy';
export const DISCOVERY_LIMIT=24;
export const DISCOVERY_WINDOW_MS=24*60*60*1000;
export interface DiscoveryEvidence { sourceId?: string; rotation?:string|null; quality?:number|null; isCorrect?:boolean|null; metadata?:unknown; eventType?:string; timestamp?:Date|string }
const meta=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
/** Existing six-item visitors retain their original budget; only fresh starts opt in. */
export function discoveryBudget(createdAt:Date|undefined|null,events:DiscoveryEvidence[],now=Date.now()):{remaining:number;adaptive:boolean}{
 const created=createdAt?.getTime();
 if(created==null||!Number.isFinite(created)||created>now)return {remaining:0,adaptive:false};
 const first=events[0];
 const metadata=meta(first?.metadata);
 const started=typeof metadata.firstReviewStartedAt==='string'?Date.parse(metadata.firstReviewStartedAt):NaN;
 const answered=first?.timestamp instanceof Date?first.timestamp.getTime():typeof first?.timestamp==='string'?Date.parse(first.timestamp):NaN;
 // Claiming a guest into a newly created account must not restart its clock.
 const originalStart=Math.min(created,...[started,answered].filter(value=>Number.isFinite(value)&&value<=now));
 if(now-originalStart>=DISCOVERY_WINDOW_MS)return {remaining:0,adaptive:false};
 const adaptive=events.length===0?now-originalStart<FIRST_REVIEW_WINDOW_MS:metadata.firstReviewVersion===2;
 return {adaptive,remaining:adaptive?Math.max(0,DISCOVERY_LIMIT-events.length):firstReviewRemaining(new Date(originalStart),events.length,now)};
}
/** Rotation evidence steers coverage, never a mastery claim. Repeated distinct answers required. */
export function discoveryRotationNeeds(events:DiscoveryEvidence[]):Map<string,number>{
 const byRotation=new Map<string,Map<string,boolean>>();
 for(const event of events){
  if(!event.rotation||!event.sourceId||event.eventType==='video_watched')continue;
  const correct=event.isCorrect ?? (event.quality==null?null:event.quality>=3);
  if(correct==null)continue;
  const answers=byRotation.get(event.rotation)??new Map();answers.set(event.sourceId,correct);byRotation.set(event.rotation,answers);
 }
 return new Map([...byRotation].map(([rotation,answers])=>[rotation,answers.size<2?0:Math.min(3,[...answers.values()].filter(v=>!v).length)]));
}
export function discoveryGoal(profile:unknown){
 const state=parseCheckIns(profile);const goal=state.answers['learning-goal'];
 return {skipped:state.discoverySkipped===true,choice:goal?.choice,text:goal?.text??'',exam:goal?.choice==='exam'||state.answers['study-purpose']?.choice==='exam'};
}
/** Free text is a literal topic preference only, never an instruction or a clinical claim. */
export function discoveryPreferenceScore(item:{kind:string;type:string;topics?:string[]},profile:unknown):number{
 const goal=discoveryGoal(profile);
 // A broad imaging choice includes neuroimaging without preferring the brain
 // over other imaging. A neuro-only interest requires an explicit neuro choice.
 const imagingMatch=goal.choice==='imaging'&&['imaging','neuroimaging'].includes(item.kind);
 const kindScore=Number(goal.choice===item.kind||imagingMatch)*4;
 const terms=goal.text.toLowerCase().match(/[a-z]{4,}/g)??[];
 const topicScore=Number((item.topics??[]).some(topic=>terms.some(word=>topic.toLowerCase().includes(word))))*2;
 return kindScore+topicScore+Number(goal.exam&&item.type==='question')*2;
}

/** Keep six ahead: three still on screen/queued plus the next three informed by real answers. */
export function discoveryBatchCapacity(adaptive:boolean,completed:number,remaining:number,excluded:number,batchSize:number):number {
 const limit=adaptive?DISCOVERY_LIMIT:FIRST_REVIEW_LIMIT;
 const prepared=adaptive?Math.min(limit,Math.max(6,completed+6)):limit;
 return Math.max(0,Math.min(remaining,prepared-excluded,batchSize,adaptive&&completed>0?3:6));
}
