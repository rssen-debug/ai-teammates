/* MAJIN foreground-voice gate.
 * A lightweight near-mic activity heuristic. This is NOT speaker identity or
 * Silero VAD; those require separately provisioned ONNX models.
 * It prevents an always-on noisy TV from keeping a recognition turn alive.
 */
(function(){
  'use strict';
  class ForegroundVoiceGate {
    constructor(){
      this.noiseFloor=0.009;
      this.calibrated=0;
      this.proximityHits=0;
      this.activeUntil=0;
      this.lastSpeech=0;
      this.maxEnergy=0;
    }
    observe(rms, now=Date.now()){
      if(!Number.isFinite(rms))return false;
      const level=Math.max(0,Math.min(1,rms));
      // Calibrate only briefly. A TV already playing when Talk is pressed
      // contributes to the noise floor rather than triggering immediately.
      if(this.calibrated<20){
        this.noiseFloor=this.calibrated===0?level:this.noiseFloor*.86+level*.14;
        this.calibrated++;
        return false;
      }
      const threshold=Math.max(.018,this.noiseFloor*2.05);
      const near=level>threshold;
      this.proximityHits=near?Math.min(12,this.proximityHits+1):Math.max(0,this.proximityHits-1);
      if(this.proximityHits>=3){
        this.lastSpeech=now;
        this.activeUntil=now+1700;
        this.maxEnergy=Math.max(level,this.maxEnergy);
      }
      // Slowly adjust background only when no foreground burst is present.
      if(!near)this.noiseFloor=Math.max(.003,this.noiseFloor*.998+level*.002);
      return this.isForeground(now);
    }
    isForeground(now=Date.now()){return now<this.activeUntil;}
    reset(){this.noiseFloor=.009;this.calibrated=0;this.proximityHits=0;this.activeUntil=0;this.lastSpeech=0;this.maxEnergy=0;}
  }
  window.MAJINForegroundVoiceGate=ForegroundVoiceGate;
})();
