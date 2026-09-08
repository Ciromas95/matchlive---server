let queued = 0, sent = 0, failed = 0, duplicateAvoided = 0, totalLatencyMs = 0;
const byTopic = new Map<string, { queued: number; sent: number; failed: number }>();
export function pushQueued(topic: string) { queued += 1; const row=byTopic.get(topic)??{queued:0,sent:0,failed:0}; row.queued+=1; byTopic.set(topic,row); return Date.now(); }
export function pushSent(topic: string, started: number) { sent+=1; totalLatencyMs+=Date.now()-started; const row=byTopic.get(topic); if(row)row.sent+=1; }
export function pushFailed(topic: string) { failed+=1; const row=byTopic.get(topic); if(row)row.failed+=1; }
export function pushDuplicateAvoided() { duplicateAvoided+=1; }
export function pushTelemetrySnapshot() { return { queued, sent, failed, duplicateAvoided, averageLatencyMs: sent?Math.round(totalLatencyMs/sent):0,
  byTopic:[...byTopic.entries()].map(([topic,value])=>({topic,...value})).sort((a,b)=>b.queued-a.queued).slice(0,20) }; }
