class BeatDetector {
    constructor(onBeat) {
        this.audioContext = null;
        this.analyser = null;
        this.dataArray = null;
        this.rafId = null;
        this.BASS_THRESHOLD = 0.10;
        this.ENERGY_HISTORY_SIZE = 43;
        this.energyHistory = [];
        this.lastBeatTime = 0;
        this.MIN_BEAT_INTERVAL = 150;
        this.prevFreqData = null;
        this.BASS_MAX_HZ = 150;
        this.SPECTRAL_FLUX_WEIGHT = 0.25; // 0.0 = only bass, 1.0 = only flux
        this.beatBuffer = [];
        this.LOOKAHEAD_MS = 100;
        this.onBeatCallback = null;
        this.detectBeats = () => {
            if (!this.analyser || !this.dataArray)
                return;
            this.analyser.getByteFrequencyData(this.dataArray);
            const lowEnergy = this.calculateBassEnergy(this.dataArray);
            const flux = this.calculateSpectralFlux(this.dataArray);
            const combined = (this.SPECTRAL_FLUX_WEIGHT * flux) + ((1 - this.SPECTRAL_FLUX_WEIGHT) * lowEnergy);
            this.energyHistory.push(combined);
            if (this.energyHistory.length > this.ENERGY_HISTORY_SIZE) {
                this.energyHistory.shift();
            }
            const avgEnergy = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;
            const variance = this.energyHistory.reduce((sum, val) => sum + Math.pow(val - avgEnergy, 2), 0) / this.energyHistory.length;
            const adaptiveThreshold = variance > 0.0005 ? this.BASS_THRESHOLD * 0.9 : this.BASS_THRESHOLD;
            const now = performance.now();
            const timeSinceLastBeat = now - this.lastBeatTime;
            if (combined > avgEnergy * (1 + adaptiveThreshold) && timeSinceLastBeat > this.MIN_BEAT_INTERVAL) {
                const beatTime = now + this.LOOKAHEAD_MS;
                this.beatBuffer.push(beatTime);
                this.lastBeatTime = now;
                if (Math.random() < 0.15) {
                    console.log('[Beat Sync] Beat detected', { lowEnergy: lowEnergy.toFixed(3), flux: flux.toFixed(3), combined: combined.toFixed(3), avg: avgEnergy.toFixed(3) });
                }
            }
            this.rafId = requestAnimationFrame(this.detectBeats);
        };
        this.processBeats = () => {
            const now = performance.now();
            while (this.beatBuffer.length > 0 && this.beatBuffer[0] <= now) {
                this.beatBuffer.shift();
                if (this.onBeatCallback) {
                    this.onBeatCallback();
                }
            }
            requestAnimationFrame(this.processBeats);
        };
        this.onBeatCallback = onBeat;
    }
    async waitForCiderAudio() {
        console.log('[Beat Sync] Waiting for CiderAudio to be fully ready...');
        for (let i = 0; i < 75; i++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            const CA = window.CiderAudio;
            if (CA && CA.context) {
                console.log('[Beat Sync] CiderAudio fully ready after', (i + 1) * 200, 'ms');
                return CA;
            }
            if (i % 10 === 0 && i > 0) {
                console.log(`[Beat Sync] Still waiting... (${i * 200}ms) - CiderAudio exists: ${!!CA}, has context: ${!!(CA?.context)}`);
            }
        }
        console.error('[Beat Sync] CiderAudio.context not ready after 15 seconds');
        return null;
    }
    async init() {
        try {
            const CiderAudio = await this.waitForCiderAudio();
            if (!CiderAudio) {
                console.error('[Beat Sync] CiderAudio not available after waiting');
                return false;
            }
            console.log('[Beat Sync] CiderAudio found:', {
                hasCiderAudio: !!CiderAudio,
                hasContext: !!CiderAudio.context,
                hasAudioNodes: !!CiderAudio.audioNodes,
                audioNodeKeys: CiderAudio.audioNodes ? Object.keys(CiderAudio.audioNodes) : []
            });
            this.audioContext = CiderAudio.context;
            if (!this.audioContext) {
                console.error('[Beat Sync] CiderAudio.context is null or undefined');
                console.error('[Beat Sync] CiderAudio object:', CiderAudio);
                return false;
            }
            console.log('[Beat Sync] Using CiderAudio context:', {
                state: this.audioContext.state,
                sampleRate: this.audioContext.sampleRate
            });
            if (this.audioContext.state === 'suspended') {
                try {
                    await this.audioContext.resume();
                    console.log('[Beat Sync] Resumed audio context');
                }
                catch (e) {
                    console.warn('[Beat Sync] Could not resume context:', e);
                }
            }
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 1024;
            this.analyser.smoothingTimeConstant = 0.35;
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            this.prevFreqData = new Uint8Array(this.analyser.frequencyBinCount);
            let sourceNode = CiderAudio.audioNodes?.gainNode ||
                CiderAudio.source ||
                CiderAudio.audioNodes?.spatialNode;
            if (!sourceNode) {
                console.error('[Beat Sync] Could not find a CiderAudio node to tap into');
                console.log('[Beat Sync] Available audioNodes:', Object.keys(CiderAudio.audioNodes || {}));
                return false;
            }
            console.log('[Beat Sync] Tapping into CiderAudio node');
            sourceNode.connect(this.analyser);
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            console.log('[Beat Sync] Audio analysis initialized successfully via CiderAudio');
            return true;
        }
        catch (error) {
            console.error('[Beat Sync] Failed to initialize audio:', error);
            return false;
        }
    }
    start() {
        if (!this.analyser || !this.dataArray) {
            console.error('[Beat Sync] Analyser not initialized');
            return;
        }
        console.log('[Beat Sync] Starting beat detection');
        this.detectBeats();
        this.processBeats();
    }
    stop() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        console.log('[Beat Sync] Stopped beat detection');
    }
    calculateBassEnergy(frequencyData) {
        if (!this.analyser || !this.audioContext)
            return 0;
        const fftSize = this.analyser.fftSize;
        const sampleRate = this.audioContext.sampleRate || 44100;
        const binWidth = sampleRate / fftSize;
        const maxBin = Math.min(Math.floor(this.BASS_MAX_HZ / binWidth), frequencyData.length - 1);
        if (maxBin < 1)
            return 0;
        let sum = 0;
        for (let i = 0; i <= maxBin; i++) {
            sum += frequencyData[i];
        }
        // normalize 0..1
        const normalized = sum / ((maxBin + 1) * 255);
        return normalized;
    }
    calculateSpectralFlux(frequencyData) {
        if (!this.prevFreqData) {
            this.prevFreqData = new Uint8Array(frequencyData.length);
            return 0;
        }
        let flux = 0;
        const len = Math.min(frequencyData.length, this.prevFreqData.length);
        for (let i = 0; i < len; i++) {
            const diff = frequencyData[i] - this.prevFreqData[i];
            if (diff > 0)
                flux += diff;
        }
        const normalized = flux / (len * 255);
        this.prevFreqData.set(frequencyData.subarray(0, len));
        return normalized;
    }
    cleanup() {
        this.stop();
        // Don't close the context - it belongs to Cider!
        if (this.analyser) {
            try {
                this.analyser.disconnect();
            }
            catch (e) {
            }
            this.analyser = null;
        }
        this.audioContext = null;
    }
}
class ImmersiveEffects {
    constructor() {
        this.immersiveElement = null;
        this.isFlashing = false;
        this.observer = null;
        this.retryTimer = null;
        this.retryIntervalMs = 2000;
        this.MAX_RETRY_INTERVAL_MS = 5000;
        this.selectors = [
            '.immersive-background',
            '[class*="immersive"]',
            '[class*="background"]',
            '.app-chrome__bg'
        ];
    }
    init() {
        if (this.tryFindNow())
            return;
        this.scheduleRetry();
        this.ensureObserver();
    }
    tryFindNow() {
        for (const selector of this.selectors) {
            const el = document.querySelector(selector);
            if (el) {
                this.immersiveElement = el;
                console.log('[Beat Sync] Found immersive element:', selector);
                this.cleanupWatcher();
                return true;
            }
        }
        return false;
    }
    startWatching(musicKit) {
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
                if (!musicKit.__beatSyncHook) {
                    musicKit.__beatSyncHook = handler;
                    musicKit.addEventListener('playbackStateDidChange', handler);
                }
            }
            catch (e) {
                console.warn('[Beat Sync] Failed to attach MusicKit watcher:', e);
            }
        }
    }
    ensureObserver() {
        if (this.observer)
            return;
        try {
            this.observer = new MutationObserver(() => {
                this.tryFindNow();
            });
            const target = document.body ?? document.documentElement;
            if (target) {
                this.observer.observe(target, { childList: true, subtree: true });
            }
        }
        catch (e) {
            console.warn('[Beat Sync] Failed to create MutationObserver:', e);
        }
    }
    scheduleRetry() {
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
    cleanupWatcher() {
        if (this.observer) {
            try {
                this.observer.disconnect();
            }
            catch (e) { }
            this.observer = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.retryIntervalMs = 2000;
    }
    flash() {
        if (!this.immersiveElement || this.isFlashing)
            return;
        this.isFlashing = true;
        const el = this.immersiveElement;
        const originalBackdropFilter = el.style.backdropFilter;
        const originalFilter = el.style.filter;
        const originalTransform = el.style.transform;
        el.style.transition = 'backdrop-filter 50ms ease-out, -webkit-backdrop-filter 50ms ease-out, filter 50ms ease-out, transform 50ms ease-out';
        el.style.backdropFilter = 'brightness(1.1) saturate(1.2)';
        el.style.filter = 'brightness(1.2)';
        el.style.transform = 'scale(1.005)';
        setTimeout(() => {
            el.style.transition = 'backdrop-filter 150ms ease-out, -webkit-backdrop-filter 150ms ease-out, filter 150ms ease-out, transform 150ms ease-out';
            el.style.backdropFilter = originalBackdropFilter;
            el.style.filter = originalFilter;
            el.style.transform = originalTransform;
            setTimeout(() => {
                el.style.transition = '';
                this.isFlashing = false;
            }, 150);
        }, 50);
    }
}
let beatDetector = null;
let immersiveEffects = null;
let isEnabled = false;
export default {
    id: "immer-sync",
    identifier: "org.stormy.immer-sync",
    name: "ImmerSync",
    description: "Just syncs the song beats to the Immersive Background (Not the most accurate)",
    version: "1.0.0",
    author: "stormy-soul",
    async setup(context = {}) {
        try {
            console.log('[Beat Sync] Plugin installing...');
            const MusicKit = context?.MusicKit ?? window.MusicKit;
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
                console.error('[Beat Sync] ❌ Failed to initialize audio analysis');
                return;
            }
            const startDetection = () => {
                if (!isEnabled && beatDetector) {
                    console.log('[Beat Sync] ▶️ Starting beat detection');
                    isEnabled = true;
                    beatDetector.start();
                }
            };
            const stopDetection = () => {
                if (isEnabled && beatDetector) {
                    console.log('[Beat Sync] ⏸️ Stopping beat detection');
                    isEnabled = false;
                    beatDetector.stop();
                }
            };
            console.log('[Beat Sync] Attempting to start detection immediately...');
            startDetection();
            if (MusicKit) {
                const addEv = MusicKit.addEventListener ?? MusicKit.on;
                if (addEv) {
                    addEv.call(MusicKit, 'playbackStateDidChange', (event) => {
                        const mkIsPlaying = (typeof MusicKit.isPlaying === 'function')
                            ? MusicKit.isPlaying()
                            : MusicKit.isPlaying;
                        const playing = mkIsPlaying || event?.state === 2;
                        if (playing) {
                            immersiveEffects?.tryFindNow?.();
                            startDetection();
                        }
                        else {
                            stopDetection();
                        }
                    });
                }
                const alreadyPlaying = (typeof MusicKit.isPlaying === 'function')
                    ? MusicKit.isPlaying()
                    : MusicKit.isPlaying;
                if (alreadyPlaying) {
                    console.log('[Beat Sync] Music already playing — starting detection');
                    startDetection();
                }
            }
            console.log('[Beat Sync] ✅ Plugin installed successfully');
        }
        catch (err) {
            console.error('[Beat Sync] Error during setup:', err);
        }
    },
    provide: {
        toggleBeatSync: () => {
            isEnabled = !isEnabled;
            console.log('[Beat Sync] Toggled:', isEnabled);
            return isEnabled;
        },
        isEnabled: () => isEnabled,
    },
};
