import { isSensitiveWindow } from './companion-observer.js';

export interface FocusSession {
  label: string;
  startedAt: number;
  lastSeenAt: number;
  elapsedMs: number;
}
export interface ActivityStore {
  get<T>(key:string): T | null | undefined;
  set<T>(key:string,value:T): void;
}
const KEY='buddy.activity.sessions.v1';
const MAX_SESSIONS=300;
const GAP_MS=30_000;
/** Local focused-window dwell measurement; no keystrokes, screenshots,
 * window text, credentials or unbounded log retention.
 *
 * A visible browser tab proves foreground focus, NOT actual video playback.
 * Time measured is observed foreground time, not total screen-on time.
 */
export class ActivityTimeline {
  constructor(private readonly store:ActivityStore, private readonly clock:()=>number=Date.now) {}
  record(title:string,processName:string,focused:boolean):void {
    if(!focused || !title.trim())return;
    const now=this.clock();
    const safe=(!isSensitiveWindow(title) && !/(?:chatgpt|claude|gemini|copilot|perplexity|sign.?in|login|incognito)/i.test(title))
      ? title.replace(/[\r\n\t]/g,' ').slice(0,110) : 'Privat aktivitet';
    const process=processName.replace(/[^a-z0-9._-]/gi,'').slice(0,32);
    const label=safe==='Privat aktivitet'?safe:(process?process+' · ':'')+safe;
    const sessions=this.sessions();
    const last=sessions[sessions.length-1];
    if(last && last.label===label && now>=last.lastSeenAt && now-last.lastSeenAt<=GAP_MS){
      // Only credit sampled foreground intervals up to the polling interval.
      last.elapsedMs+=Math.min(now-last.lastSeenAt,GAP_MS);
      last.lastSeenAt=now;
    }else sessions.push({label,startedAt:now,lastSeenAt:now,elapsedMs:0});
    this.store.set(KEY,sessions.slice(-MAX_SESSIONS));
  }
  sessions():FocusSession[]{
    const value=this.store.get<FocusSession[]>(KEY);
    return Array.isArray(value)?value.filter(x=>typeof x?.label==='string'&&
      Number.isFinite(x.startedAt)&&Number.isFinite(x.lastSeenAt)&&Number.isFinite(x.elapsedMs)).slice(-MAX_SESSIONS):[];
  }
  recent(count=10):FocusSession[]{return this.sessions().slice(-Math.max(1,Math.min(50,count))).reverse();}
  clear():void{this.store.set(KEY,[]);}
}
