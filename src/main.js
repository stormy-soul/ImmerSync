class BeatDetector {
    constructor(onBeat) {
        this.audioContext = null;
        this.analyser = null;
        this.dataArray = null;
        this.rafId = null;
        // Audio configuration
        this.FFT_SIZE = 2048; // 2048 is usually snappier than 4096 for timing
        this.KICK_MIN_HZ = 40;
        this.KICK_MAX_HZ = 120; // Tightened to focus on the "thud"
        this.BASS_MIN_HZ = 120;
        this.BASS_MAX_HZ = 250;
        // 1. HARD FLOOR: Beats must be at least this strong (0.0 - 1.0)
        // This filters out the "0.047", "0.010" noise in your logs.
        this.MIN_KICK_THRESHOLD = 0.18;
        // 2. DYNAMIC SENSITIVITY: How much louder than the average?
        this.THRESHOLD_MULTIPLIER = 1.5;
        this.MIN_BEAT_INTERVAL = 250; // ms
        this.lastBeatTime = 0;
        // History
        this.HISTORY_SIZE = 30; // Shorter history adapts faster to drops
        this.kickHistory = [];
        // Previous frame data
        this.prevKickEnergy = 0;
        this.prevBassEnergy = 0;
        // Buffer
        this.beatBuffer = [];
        this.LOOKAHEAD_MS = 100; // Lowered slightly for tighter sync
        this.onBeatCallback = null;
        // Debug
        this.ENABLE_DEBUG_LOGS = true;
        this.detectBeats = () => {
            // 1. Safety Check: Restart loop if analyser is missing (don't return!)
            if (!this.analyser || !this.dataArray) {
                this.rafId = requestAnimationFrame(this.detectBeats);
                return;
            }
            this.analyser.getByteFrequencyData(this.dataArray);
            // 2. Get Energy
            const kickEnergy = this.getFrequencyRangeEnergy(this.KICK_MIN_HZ, this.KICK_MAX_HZ);
            const bassEnergy = this.getFrequencyRangeEnergy(this.BASS_MIN_HZ, this.BASS_MAX_HZ);
            // 3. Calculate Impulse (The "Hit")
            // Simple difference from last frame
            const kickImpulse = Math.max(0, kickEnergy - this.prevKickEnergy);
            const bassImpulse = Math.max(0, bassEnergy - this.prevBassEnergy);
            // Store for next frame
            this.prevKickEnergy = kickEnergy;
            this.prevBassEnergy = bassEnergy;
            // 4. Update Average History
            this.kickHistory.push(kickImpulse);
            if (this.kickHistory.length > this.HISTORY_SIZE)
                this.kickHistory.shift();
            // Wait for history to fill
            if (this.kickHistory.length < this.HISTORY_SIZE) {
                this.rafId = requestAnimationFrame(this.detectBeats);
                return;
            }
            // 5. Dynamic Threshold Calculation
            const avgImpulse = this.kickHistory.reduce((a, b) => a + b, 0) / this.kickHistory.length;
            // The Threshold is the average energy * multiplier
            // BUT we enforce a minimum floor (Math.max)
            const dynamicThreshold = Math.max(this.MIN_KICK_THRESHOLD, avgImpulse * this.THRESHOLD_MULTIPLIER);
            const now = performance.now();
            const timeSinceLastBeat = now - this.lastBeatTime;
            // 6. Beat Detection Logic
            // We strictly check kickImpulse vs bassImpulse to ensure it's a "thud" not a "hum"
            const isKickDominant = kickImpulse > (bassImpulse * 1.1);
            const isAboveThreshold = kickImpulse > dynamicThreshold;
            const isTimingReady = timeSinceLastBeat > this.MIN_BEAT_INTERVAL;
            if (isAboveThreshold && isKickDominant && isTimingReady) {
                const beatTime = now + this.LOOKAHEAD_MS;
                this.beatBuffer.push(beatTime);
                this.lastBeatTime = now;
                if (this.ENABLE_DEBUG_LOGS) {
                    console.log(`[ImmerSync] 🥁 BEAT | Force: ${kickImpulse.toFixed(2)} | Threshold: ${dynamicThreshold.toFixed(2)}`);
                }
            }
            this.rafId = requestAnimationFrame(this.detectBeats);
        };
        this.processBeats = () => {
            const now = performance.now();
            while (this.beatBuffer.length > 0 && this.beatBuffer[0] <= now) {
                this.beatBuffer.shift();
                this.onBeatCallback?.();
            }
            requestAnimationFrame(this.processBeats);
        };
        this.onBeatCallback = onBeat;
    }
    async waitForCiderAudio() {
        for (let i = 0; i < 75; i++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            const CA = window.CiderAudio;
            if (CA && CA.context)
                return CA;
        }
        return null;
    }
    async init() {
        try {
            const CiderAudio = await this.waitForCiderAudio();
            if (!CiderAudio?.context)
                return false;
            this.audioContext = CiderAudio.context;
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = this.FFT_SIZE;
            // CRITICAL: Lower smoothing means faster reaction to drums
            // 0.8 = slow/smooth, 0.1 = twitchy/fast. 0.15 is a sweet spot for beats.
            this.analyser.smoothingTimeConstant = 0.15;
            const sourceNode = CiderAudio.audioNodes?.gainNode ||
                CiderAudio.source ||
                CiderAudio.audioNodes?.spatialNode;
            if (!sourceNode)
                return false;
            sourceNode.connect(this.analyser);
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            return true;
        }
        catch (error) {
            console.error('[ImmerSync] Init failed:', error);
            return false;
        }
    }
    start() {
        if (this.rafId)
            return; // Prevent double loops
        if (!this.analyser || !this.dataArray) {
            // Auto-recover if possible
            this.init().then(success => {
                if (success)
                    this.detectBeats();
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
    getFrequencyRangeEnergy(minHz, maxHz) {
        if (!this.analyser || !this.dataArray)
            return 0;
        const sampleRate = this.audioContext?.sampleRate || 44100;
        const binWidth = sampleRate / this.analyser.fftSize;
        const minBin = Math.floor(minHz / binWidth);
        const maxBin = Math.min(Math.floor(maxHz / binWidth), this.dataArray.length - 1);
        if (minBin >= maxBin)
            return 0;
        let sum = 0;
        for (let i = minBin; i <= maxBin; i++) {
            sum += this.dataArray[i];
        }
        // Normalize to 0.0 - 1.0
        return sum / ((maxBin - minBin + 1) * 255);
    }
    cleanup() {
        this.stop();
        this.analyser?.disconnect();
        this.analyser = null;
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
let beatDetector = null;
let immersiveEffects = null;
let isEnabled = false;
export default {
    id: "immer-sync",
    identifier: "me.stormy.immer-sync",
    name: "ImmerSync",
    description: "Just syncs the song beats to the Immersive Background (Not the most accurate)",
    version: "1.0.0",
    author: "stormy-soul",
    async setup(context = {}) {
        try {
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
                    startDetection();
                }
            }
        }
        catch (err) {
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
