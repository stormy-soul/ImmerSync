class BeatDetector {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array | null = null;
  private rafId: number | null = null;
  
  private readonly FFT_SIZE = 2048; 
  private readonly KICK_MIN_HZ = 40;
  private readonly KICK_MAX_HZ = 120; 
  private readonly BASS_MIN_HZ = 120;
  private readonly BASS_MAX_HZ = 250;
  
  private readonly MIN_KICK_THRESHOLD = 0.15; 

  private readonly THRESHOLD_MULTIPLIER = 1.5; 

  private readonly MIN_BEAT_INTERVAL = 250; 
  private lastBeatTime = 0;
  
  private readonly HISTORY_SIZE = 30;
  private kickHistory: number[] = [];
  
  private prevKickEnergy = 0;
  private prevBassEnergy = 0;
  
  private beatBuffer: number[] = [];
  private readonly LOOKAHEAD_MS = 100; \
  
  private onBeatCallback: (() => void) | null = null;
  
  private readonly ENABLE_DEBUG_LOGS = true;
  
  constructor(onBeat: () => void) {
    this.onBeatCallback = onBeat;
  }
  
  private async waitForCiderAudio(): Promise<any> {    
    for (let i = 0; i < 75; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const CA = (window as any).CiderAudio;
      if (CA && CA.context) return CA;
    }
    return null;
  }
  
  async init(): Promise<boolean> {
    try {
      const CiderAudio = await this.waitForCiderAudio();
      if (!CiderAudio?.context) return false;
      
      this.audioContext = CiderAudio.context;
      
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.FFT_SIZE; 
      
      this.analyser.smoothingTimeConstant = 0.15; 
      
      const sourceNode = CiderAudio.audioNodes?.gainNode || 
                        CiderAudio.source ||
                        CiderAudio.audioNodes?.spatialNode;
      
      if (!sourceNode) return false;
      
      sourceNode.connect(this.analyser);
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      
      return true;
    } catch (error) {
      console.error('[ImmerSync] Init failed:', error);
      return false;
    }
  }
  
  start() {
    if (this.rafId) return; 
    if (!this.analyser || !this.dataArray) {
      this.init().then(success => {
        if(success) this.detectBeats();
      });
      return;
    }
    this.detectBeats();
    this.processBeats();
  }
  
  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
  
  private detectBeats = () => {
    if (!this.analyser || !this.dataArray) {
      this.rafId = requestAnimationFrame(this.detectBeats);
      return;
    }
    
    this.analyser.getByteFrequencyData(
      this.dataArray as Uint8Array<ArrayBuffer>
    );    
    const kickEnergy = this.getFrequencyRangeEnergy(this.KICK_MIN_HZ, this.KICK_MAX_HZ);
    const bassEnergy = this.getFrequencyRangeEnergy(this.BASS_MIN_HZ, this.BASS_MAX_HZ);
    
    const kickImpulse = Math.max(0, kickEnergy - this.prevKickEnergy);
    const bassImpulse = Math.max(0, bassEnergy - this.prevBassEnergy);
    
    this.prevKickEnergy = kickEnergy;
    this.prevBassEnergy = bassEnergy;
    
    this.kickHistory.push(kickImpulse);
    if (this.kickHistory.length > this.HISTORY_SIZE) this.kickHistory.shift();
    
    if (this.kickHistory.length < this.HISTORY_SIZE) {
      this.rafId = requestAnimationFrame(this.detectBeats);
      return;
    }
    
    const avgImpulse = this.kickHistory.reduce((a, b) => a + b, 0) / this.kickHistory.length;
    
    const dynamicThreshold = Math.max(
      this.MIN_KICK_THRESHOLD, 
      avgImpulse * this.THRESHOLD_MULTIPLIER
    );

    const now = performance.now();
    const timeSinceLastBeat = now - this.lastBeatTime;
    
    const isKickDominant = kickImpulse > (bassImpulse * 1.1); 
    const isAboveThreshold = kickImpulse > dynamicThreshold;
    const isTimingReady = timeSinceLastBeat > this.MIN_BEAT_INTERVAL;

    if (isAboveThreshold && isKickDominant && isTimingReady) {
      
      const beatTime = now + this.LOOKAHEAD_MS;
      this.beatBuffer.push(beatTime);
      this.lastBeatTime = now;
      
      if (this.ENABLE_DEBUG_LOGS) {
        console.log(`[ImmerSync] Hit! [ Force: ${kickImpulse.toFixed(2)} | Threshold: ${dynamicThreshold.toFixed(2)} ]`);
      }
    }
    
    this.rafId = requestAnimationFrame(this.detectBeats);
  }
  
  private getFrequencyRangeEnergy(minHz: number, maxHz: number): number {
    if (!this.analyser || !this.dataArray) return 0;
    
    const sampleRate = this.audioContext?.sampleRate || 44100;
    const binWidth = sampleRate / this.analyser.fftSize;
    
    const minBin = Math.floor(minHz / binWidth);
    const maxBin = Math.min(Math.floor(maxHz / binWidth), this.dataArray.length - 1);
    
    if (minBin >= maxBin) return 0;
    
    let sum = 0;
    for (let i = minBin; i <= maxBin; i++) {
      sum += this.dataArray[i];
    }
    
    return sum / ((maxBin - minBin + 1) * 255);
  }
  
  private processBeats = () => {
    const now = performance.now();
    while (this.beatBuffer.length > 0 && this.beatBuffer[0] <= now) {
      this.beatBuffer.shift();
      this.onBeatCallback?.();
    }
    requestAnimationFrame(this.processBeats);
  }

  cleanup() {
    this.stop();
    this.analyser?.disconnect();
    this.analyser = null;
    this.audioContext = null;
  }
}

class ImmersiveEffects {
  private immersiveElement: HTMLElement | null = null;
  private isFlashing = false;
  private observer: MutationObserver | null = null;
  private retryTimer: number | null = null;
  private retryIntervalMs = 2000;
  private readonly MAX_RETRY_INTERVAL_MS = 5000;
  private readonly selectors = [
    '.immersive-background',
    '[class*="immersive"]',
    '[class*="background"]',
    '.app-chrome__bg'
  ];

  init(): void {
    if (this.tryFindNow()) return;
    this.scheduleRetry();
    this.ensureObserver();
  }

  tryFindNow(): boolean {
    for (const selector of this.selectors) {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el) {
        this.immersiveElement = el;
        this.cleanupWatcher();
        return true;
      }
    }
    return false;
  }

  startWatching(musicKit?: any) {
    this.ensureObserver();
    if (musicKit && typeof musicKit.addEventListener === 'function') {
      try {
        const handler = () => {
          const mkIsPlaying = (typeof musicKit.isPlaying === 'function')
            ? musicKit.isPlaying()
            : musicKit.isPlaying;
          if (mkIsPlaying) {
            this.tryFindNow();
          }
        };
        if (!(musicKit as any).__beatSyncHook) {
          (musicKit as any).__beatSyncHook = handler;
          musicKit.addEventListener('playbackStateDidChange', handler);
        }
      } catch (e) {
      }
    }
  }

  private ensureObserver() {
    if (this.observer) return;
    try {
      this.observer = new MutationObserver(() => {
        this.tryFindNow();
      });
      const target = document.body ?? document.documentElement;
      if (target) {
        this.observer.observe(target, { childList: true, subtree: true });
      }
    } catch (e) {
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.tryFindNow()) {
        this.retryIntervalMs = Math.min(this.retryIntervalMs + 1000, this.MAX_RETRY_INTERVAL_MS);
        this.scheduleRetry();
      }
    }, this.retryIntervalMs);
  }

  private cleanupWatcher() {
    if (this.observer) {
      try {
        this.observer.disconnect();
      } catch (e) {}
      this.observer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryIntervalMs = 2000;
  }

  flash() {
    if (!this.immersiveElement || this.isFlashing) return;

    this.isFlashing = true;
    const el = this.immersiveElement;
    
    const originalBackdropFilter = el.style.backdropFilter;
    const originalFilter = el.style.filter;
    //const originalTransform = el.style.transform;

    el.style.transition = 'backdrop-filter 50ms ease-out, -webkit-backdrop-filter 50ms ease-out, transform 50ms ease-out';
    el.style.backdropFilter = 'brightness(1.08) saturate(1.1)';
    //el.style.transform = 'scale(1.002)';

    setTimeout(() => {
      el.style.transition = 'backdrop-filter 150ms ease-out, -webkit-backdrop-filter 150ms ease-out, transform 150ms ease-out';
      el.style.backdropFilter = originalBackdropFilter;
      el.style.filter = originalFilter;
      //el.style.transform = originalTransform;
      
      setTimeout(() => {
        el.style.transition = '';
        this.isFlashing = false;
      }, 150);
    }, 50);
  }
}

let beatDetector: BeatDetector | null = null;
let immersiveEffects: ImmersiveEffects | null = null;
let isEnabled = false;

export default {
  id: "immer-sync",
  identifier: "me.stormy.immer-sync",
  name: "ImmerSync",
  description: "Just syncs the song beats to the Immersive Background (Not the most accurate)",
  version: "1.0.0",
  author: "stormy-soul",

  async setup(context: any = {}) {
    try {

      const MusicKit = context?.MusicKit ?? (window as any).MusicKit;

      immersiveEffects = new ImmersiveEffects();
      immersiveEffects.init();
      immersiveEffects.startWatching(MusicKit);

      beatDetector = new BeatDetector(() => {
        if (isEnabled && immersiveEffects) {
          immersiveEffects.flash();
        }
      });

      const audioReady = await beatDetector.init();
      if (!audioReady) {
        console.error('[ImmerSync] Failed to initialize audio analysis');
        return;
      }

      const startDetection = () => {
        if (!isEnabled && beatDetector) {
          isEnabled = true;
          beatDetector.start();
        }
      };
      
      const stopDetection = () => {
        if (isEnabled && beatDetector) {
          isEnabled = false;
          beatDetector.stop();
        }
      };

      //console.log('[ImmerSync] Attempting to start detection immediately...');
      startDetection();

      if (MusicKit) {
        const addEv = (MusicKit as any).addEventListener ?? (MusicKit as any).on;
        if (addEv) {
          addEv.call(MusicKit, 'playbackStateDidChange', (event: any) => {
            const mkIsPlaying = (typeof (MusicKit as any).isPlaying === 'function')
              ? (MusicKit as any).isPlaying()
              : (MusicKit as any).isPlaying;
            const playing = mkIsPlaying || event?.state === 2;
            
            if (playing) {
              immersiveEffects?.tryFindNow?.();
              startDetection();
            } else {
              stopDetection();
            }
          });
        }

        const alreadyPlaying = (typeof (MusicKit as any).isPlaying === 'function')
          ? (MusicKit as any).isPlaying()
          : (MusicKit as any).isPlaying;
        if (alreadyPlaying) {
          startDetection();
        }
      }

    } catch (err) {
      console.error('[ImmerSync] Error during setup:', err);
    }
  },

  provide: {
    toggleBeatSync: () => {
      isEnabled = !isEnabled;
      return isEnabled;
    },
    isEnabled: () => isEnabled,
  },
};