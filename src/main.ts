
class BeatDetector {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array | null = null;
  private rafId: number | null = null;
  
  private readonly BASS_THRESHOLD = 0.10;
  private readonly ENERGY_HISTORY_SIZE = 43;
  private energyHistory: number[] = [];
  private lastBeatTime = 0;
  private readonly MIN_BEAT_INTERVAL = 150;

  private prevFreqData: Uint8Array | null = null;
  private readonly FFT_SIZE = 1024;
  private readonly BASS_MAX_HZ = 150;    
  private readonly FLUX_MAX_HZ = 200;        
  private readonly SPECTRAL_FLUX_WEIGHT = 0.3;

  private beatBuffer: number[] = [];
  private readonly LOOKAHEAD_MS = 100;
  
  private onBeatCallback: (() => void) | null = null;
  
  constructor(onBeat: () => void) {
    this.onBeatCallback = onBeat;
  }
  
  private async waitForCiderAudio(): Promise<any> {    
    for (let i = 0; i < 75; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const CA = (window as any).CiderAudio;
      if (CA && CA.context) {
        console.log('[ImmerSync] CiderAudio fully ready after', (i + 1) * 200, 'ms');
        return CA;
      }
    }
    
    return null;
  }
  
  async init(): Promise<boolean> {
    try {
      const CiderAudio = await this.waitForCiderAudio();
      
      if (!CiderAudio) {
        console.error('[ImmerSync] CiderAudio not available after waiting');
        return false;
      }
      
      console.log('[ImmerSync] CiderAudio found:', {
        hasCiderAudio: !!CiderAudio,
        hasContext: !!CiderAudio.context,
        hasAudioNodes: !!CiderAudio.audioNodes,
        audioNodeKeys: CiderAudio.audioNodes ? Object.keys(CiderAudio.audioNodes) : []
      });
      
      this.audioContext = CiderAudio.context;
      
      if (!this.audioContext) {
        console.error('[ImmerSync] CiderAudio.context is null or undefined');
        console.error('[ImmerSync] CiderAudio object:', CiderAudio);
        return false;
      }
      
      console.log('[ImmerSync] Using CiderAudio context:', {
        state: this.audioContext.state,
        sampleRate: this.audioContext.sampleRate
      });
      
      if (this.audioContext.state === 'suspended') {
        try {
          await this.audioContext.resume();
          console.log('[ImmerSync] Resumed audio context');
        } catch (e) {
          console.warn('[ImmerSync] Could not resume context:', e);
        }
      }
      
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.FFT_SIZE; 
      this.analyser.smoothingTimeConstant = 0.1;

      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.prevFreqData = new Uint8Array(this.analyser.frequencyBinCount);

      
      let sourceNode = CiderAudio.audioNodes?.gainNode || 
                       CiderAudio.source ||
                       CiderAudio.audioNodes?.spatialNode;
      
      if (!sourceNode) {
        return false;
      }
      
      sourceNode.connect(this.analyser);
      
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      
      console.log('[ImmerSync] Audio analysis initialized successfully via CiderAudio');
      return true;
    } catch (error) {
      console.error('[ImmerSync] Failed to initialize audio:', error);
      return false;
    }
  }
  
  start() {
    if (!this.analyser || !this.dataArray) {
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
    if (!this.analyser || !this.dataArray) return;

    this.analyser.getByteFrequencyData(
      this.dataArray as Uint8Array<ArrayBuffer>
    );
    const lowEnergy = this.calculateBassEnergy(this.dataArray as Uint8Array);
    const flux = this.calculateSpectralFlux(this.dataArray as Uint8Array);

    const combined = (this.SPECTRAL_FLUX_WEIGHT * flux) + ((1 - this.SPECTRAL_FLUX_WEIGHT) * lowEnergy);

    this.energyHistory.push(combined);
    if (this.energyHistory.length > this.ENERGY_HISTORY_SIZE) {
      this.energyHistory.shift();
    }

    const avgEnergy = this.energyHistory.reduce((a,b) => a + b, 0) / this.energyHistory.length;

    const variance = this.energyHistory.reduce((sum, val) => sum + Math.pow(val - avgEnergy, 2), 0) / this.energyHistory.length;
    const adaptiveThreshold = variance > 0.0005 ? this.BASS_THRESHOLD * 0.9 : this.BASS_THRESHOLD;

    const now = performance.now();
    const timeSinceLastBeat = now - this.lastBeatTime;

    if (combined > avgEnergy * (1 + adaptiveThreshold) && timeSinceLastBeat > this.MIN_BEAT_INTERVAL) {
      const beatTime = now + this.LOOKAHEAD_MS;
      this.beatBuffer.push(beatTime);
      this.lastBeatTime = now;
    }

    this.rafId = requestAnimationFrame(this.detectBeats);
  }
  
  private calculateBassEnergy(frequencyData: Uint8Array): number {
    if (!this.analyser || !this.audioContext) return 0;

    const sampleRate = this.audioContext.sampleRate || 44100;
    const binWidth = sampleRate / this.analyser.fftSize; 

    const maxBin = Math.min(
      Math.floor(this.BASS_MAX_HZ / binWidth),
      frequencyData.length - 1
    );

    if (maxBin < 1) return 0;

    let sum = 0;
    for (let i = 0; i <= maxBin; i++) {
      sum += frequencyData[i];
    }

    const normalized = sum / ((maxBin + 1) * 255);
    return normalized;
  }

  private calculateSpectralFlux(frequencyData: Uint8Array): number {
    if (!this.prevFreqData) {
      this.prevFreqData = new Uint8Array(frequencyData.length);
      return 0;
    }

    if (!this.analyser || !this.audioContext) return 0;

    const sampleRate = this.audioContext.sampleRate || 44100;
    const binWidth = sampleRate / this.analyser.fftSize;
    
    const maxBin = Math.min(
      Math.floor(this.FLUX_MAX_HZ / binWidth),
      frequencyData.length - 1
    );

    let flux = 0;
    for (let i = 0; i <= maxBin; i++) {
      const diff = frequencyData[i] - this.prevFreqData[i];
      if (diff > 0) {
        flux += diff;
      }
    }

    this.prevFreqData.set(frequencyData);

    const normalized = flux / ((maxBin + 1) * 255);
    return normalized;
  }

  
  private processBeats = () => {
    const now = performance.now();
    
    while (this.beatBuffer.length > 0 && this.beatBuffer[0] <= now) {
      this.beatBuffer.shift();
      
      if (this.onBeatCallback) {
        this.onBeatCallback();
      }
    }
    
    requestAnimationFrame(this.processBeats);
  }
  
  cleanup() {
    this.stop();
    // Don't close the context - it belongs to Cider!
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch (e) {
      }
      this.analyser = null;
    }
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

    el.style.transition = 'backdrop-filter 50ms ease-out, -webkit-backdrop-filter 50ms ease-out, filter 50ms ease-out, transform 50ms ease-out';
    el.style.backdropFilter = 'brightness(1.08) saturate(1.2)';

    setTimeout(() => {
      el.style.transition = 'backdrop-filter 150ms ease-out, -webkit-backdrop-filter 150ms ease-out, filter 150ms ease-out, transform 150ms ease-out';
      el.style.backdropFilter = originalBackdropFilter;
      el.style.filter = originalFilter;
      
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