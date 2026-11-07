/** Lightweight bounded tool heartbeat, adapted from local-first agent tracing
 * patterns (AgentTrace/OpenTelemetry). Reports *elapsed waiting time only*.
 * Never reports an action as successful and never captures arguments or secrets.
 */
export function startToolHeartbeat({tool, emit, intervalMs=8000, clock=()=>Date.now()}={}){
  const name=String(tool||'unknown').slice(0,100);
  const period=Math.max(20,Math.min(60000,Number(intervalMs)||8000));
  const begun=clock();
  let stopped=false, ticks=0;
  const timer=setInterval(()=>{
    if(stopped)return;
    ticks++;
    try{emit?.({type:'tool_waiting',tool:name,elapsedMs:Math.max(0,clock()-begun),ticks});}catch{/* telemetry must never break execution */}
  },period);
  timer.unref?.();
  return {
    stop(){
      if(stopped)return null;
      stopped=true;clearInterval(timer);
      return {tool:name,elapsedMs:Math.max(0,clock()-begun),ticks};
    }
  };
}
