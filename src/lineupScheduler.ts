import { getFixturesByDate } from "./apiFootball";
import { getLineupForFixture } from "./lineupPrediction";
import { features } from "./featureFlags";
import { canStartJobs, trackJob } from "./lifecycle";
import { withJobLease } from "./redisInfrastructure";
import { log } from "./logger";

const WINDOWS = [72*60,24*60,6*60,3*60,90,60];
const completed = new Map<string,number>();
let timer: NodeJS.Timeout | null = null;
let lastCycleAt: string | null = null, lastSuccessAt: string | null = null, lastError: string | null = null, pending = 0, generated = 0;

function day(offset: number) { const d=new Date(Date.now()+offset*86400000); return d.toISOString().slice(0,10); }
function dueWindow(minutes: number) { return WINDOWS.find((window)=>minutes<=window && minutes>window-20) ?? null; }

async function cycle() {
  if (!features.lineupPrecompute || !canStartJobs()) return;
  lastCycleAt = new Date().toISOString();
  try {
    const payloads = await Promise.all([0,1,2,3].map((offset)=>getFixturesByDate(day(offset))));
    const now=Date.now();
    const due = payloads.flatMap((p:any)=>Array.isArray(p?.response)?p.response:[]).map((fixture:any)=>({fixture,id:Number(fixture?.fixture?.id??0),kickoff:Date.parse(fixture?.fixture?.date??"")}))
      .filter((x)=>x.id>0 && Number.isFinite(x.kickoff) && /^(NS|TBD)$/.test(String(x.fixture?.fixture?.status?.short??"NS")))
      .map((x)=>({...x,window:dueWindow((x.kickoff-now)/60000)})).filter((x)=>x.window!=null && !completed.has(`${x.id}:${x.window}`)).slice(0,4);
    pending=due.length;
    for(const item of due){
      await withJobLease(`lineup:${item.id}:${item.window}`,15*60_000,async()=>{ await getLineupForFixture(item.id); completed.set(`${item.id}:${item.window}`,Date.now()); generated+=1; });
    }
    lastSuccessAt=new Date().toISOString(); lastError=null; pending=0;
    for(const [key,at] of completed) if(Date.now()-at>96*60*60_000) completed.delete(key);
  }catch(error:any){lastError=error?.code??"cycle_failed";log("error","lineup-scheduler","precompute cycle failed",{errorCode:lastError});}
}

export function startLineupScheduler(){ if(!features.lineupPrecompute)return()=>{}; void trackJob(cycle()); timer=setInterval(()=>void trackJob(cycle()),15*60_000); timer.unref(); return()=>{if(timer)clearInterval(timer);timer=null;}; }
export function lineupSchedulerSnapshot(){return{enabled:features.lineupPrecompute,lastCycleAt,lastSuccessAt,lastError,pending,generated,windowsMinutes:WINDOWS};}
