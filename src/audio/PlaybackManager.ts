import { getSubsonicClient } from '../api/SubsonicClient';
import { usePlayerStore } from '../stores/playerStore';
import { useEQStore } from '../stores/eqStore';
import { useUIStore } from '../stores/uiStore';
import { getCastManager } from './CastManager';
import type { Song } from '../types/subsonic';
import type { RadioState } from '../stores/playerStore';

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_Q = 1.414;
const POSITION_UPDATE_MS = 250;
const SCROBBLE_MIN_SECONDS = 30;
const SCROBBLE_PERCENT = 0.5;
// Sleep fade duration is now configurable via uiStore.sleepFadeDuration

function isIOSWebPlaybackEnvironment(): boolean {
  if (typeof navigator === 'undefined') return false;

  const userAgent = navigator.userAgent ?? '';
  const platform = navigator.platform ?? '';
  const touchCapableMac = platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  return /iPad|iPhone|iPod/i.test(userAgent) || touchCapableMac;
}

function isStandalonePWA(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

  const legacyNavigator = navigator as Navigator & { standalone?: boolean };
  const standaloneByNavigator = legacyNavigator.standalone === true;
  const standaloneByDisplayMode = typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: standalone)').matches
    : false;

  return standaloneByNavigator || standaloneByDisplayMode;
}

class PlaybackManager {
  private audioContext: AudioContext | null = null;
  private playerA: HTMLAudioElement;
  private playerB: HTMLAudioElement;
  private activePlayer: 'A' | 'B' = 'A';
  private sourceA: MediaElementAudioSourceNode | null = null;
  private sourceB: MediaElementAudioSourceNode | null = null;
  private gainA: GainNode | null = null;
  private gainB: GainNode | null = null;
  private eqFilters: BiquadFilterNode[] = [];
  private analyser: AnalyserNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private positionInterval: number | null = null;
  private scrobbled = false;
  private crossfadeTimer: number | null = null;
  private crossfading = false;
  private sleepTimerId: number | null = null;
  private sleepFadeInterval: number | null = null;
  private sleepRemainingMs = 0;
  private currentVolume = 1;
  private previousVolume = 1;
  private playId = 0;
  private radioAudio: HTMLAudioElement | null = null;
  private radioPlayId = 0;
  private unsubscribeEQ: (() => void) | null = null;
  private preloadedSongId: string | null = null;
  private preloadedIndex: number = -1;
  private readonly backgroundSafeMode = isIOSWebPlaybackEnvironment();
  private currentReplayGainMultiplier = 1;
  private positionTimerType: 'raf' | 'interval' | null = null;
  private readonly visibilityHandler = () => {
    this.debugLog('visibilitychange', {
      hidden: typeof document !== 'undefined' ? document.hidden : undefined,
      visibilityState: typeof document !== 'undefined' ? document.visibilityState : undefined,
    });
    if (typeof document !== 'undefined' && !document.hidden) {
      this.configureAudioSession();
      this.recoverPlaybackAfterForeground();
    }
  };
  private readonly pageShowHandler = () => {
    this.debugLog('pageshow');
    this.configureAudioSession();
    this.recoverPlaybackAfterForeground();
  };
  // Suppresses the external-pause handler while we pause the audio element
  // internally (e.g. during play() source swap, crossfade, gapless handoff).
  private internalPause = false;

  constructor() {
    this.playerA = new Audio();
    this.playerB = new Audio();
    this.playerA.preload = 'auto';
    this.playerB.preload = 'auto';
    this.playerA.crossOrigin = 'anonymous';
    this.playerB.crossOrigin = 'anonymous';
    this.playerA.volume = this.currentVolume;
    this.playerB.volume = this.currentVolume;

    // Handle track ended events
    this.playerA.addEventListener('ended', () => this.handleTrackEnded('A'));
    this.playerB.addEventListener('ended', () => this.handleTrackEnded('B'));

    // Handle errors
    this.playerA.addEventListener('error', () => this.handleError('A'));
    this.playerB.addEventListener('error', () => this.handleError('B'));

    // Handle duration metadata
    this.playerA.addEventListener('loadedmetadata', () => this.handleMetadata('A'));
    this.playerB.addEventListener('loadedmetadata', () => this.handleMetadata('B'));
    this.playerA.addEventListener('timeupdate', () => this.handleTimeUpdate('A'));
    this.playerB.addEventListener('timeupdate', () => this.handleTimeUpdate('B'));
    this.playerA.addEventListener('ratechange', () => this.handleRateChange('A'));
    this.playerB.addEventListener('ratechange', () => this.handleRateChange('B'));
    this.playerA.addEventListener('playing', () => this.handlePlaying('A'));
    this.playerB.addEventListener('playing', () => this.handlePlaying('B'));

    // Detect external pauses (OS audio-focus loss, Bluetooth dropout, buffer underrun)
    // so the UI reflects reality instead of showing "playing" while silent.
    this.playerA.addEventListener('pause', () => this.handleExternalPause('A'));
    this.playerB.addEventListener('pause', () => this.handleExternalPause('B'));

    // When the cast session ends (user disconnects, network drops, etc.), resume
    // playback locally at the same position so the music doesn't just stop.
    getCastManager().onSessionEnd((lastPositionMs) => this.handleCastSessionEnded(lastPositionMs));

    this.configureAudioSession();
    this.debugLog('constructed', {
      backgroundSafeMode: this.backgroundSafeMode,
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', this.pageShowHandler);
    }
  }

  /** Call from a user gesture to ensure AudioContext is running before async work. */
  warmup(): void {
    this.configureAudioSession();
    if (this.backgroundSafeMode) return;
    this.ensureAudioContext();
  }

  /** Create AudioContext if needed and resume if suspended. */
  private ensureAudioContext(): void {
    if (this.backgroundSafeMode) return;
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  /** Connect audio elements to Web Audio graph (for EQ, visualizer). Lazy — called after first play. */
  private ensureAudioChain(): void {
    if (this.backgroundSafeMode) return;
    if (this.sourceA) return; // Already connected

    this.ensureAudioContext();
    this.setupAudioChain();

    // Subscribe to EQ store changes (only once)
    if (!this.unsubscribeEQ) {
      this.unsubscribeEQ = useEQStore.subscribe((state) => {
        this.updateEQ(state.bands, state.enabled);
      });
    }

    // Apply current EQ state
    const eqState = useEQStore.getState();
    this.updateEQ(eqState.bands, eqState.enabled);
  }

  init(): void {
    this.configureAudioSession();
    if (this.backgroundSafeMode) return;
    this.ensureAudioChain();
  }

  async play(song: Song): Promise<void> {
    // Guard against rapid-fire calls (e.g. clicking next repeatedly)
    const thisPlayId = ++this.playId;

    // If casting, send to Chromecast instead of local playback
    const uiState = useUIStore.getState();
    if (uiState.castConnected) {
      const client = getSubsonicClient();
      const quality = uiState.streamQuality;
      const url = client.stream(song.id, quality || undefined);
      const artUrl = song.coverArt ? client.getCoverArt(song.coverArt, 512) : undefined;
      await getCastManager().loadMedia(url, song.title, song.artist ?? 'Unknown Artist', song.album ?? 'Unknown Album', artUrl);
      this.scrobbled = false;
      getSubsonicClient().scrobble(song.id, false).catch(() => {});
      this.updateMediaSession(song);
      this.startPositionTracking();
      return;
    }

    // Cancel any active crossfade and clear preload
    this.cancelCrossfade();
    this.clearPreload();

    const shouldSwapPlayersForBackgroundTrackChange = this.backgroundSafeMode && this.hasSource();
    const targetPlayer = shouldSwapPlayersForBackgroundTrackChange
      ? (this.activePlayer === 'A' ? 'B' : 'A')
      : this.activePlayer;
    const audio = this.getAudioForPlayer(targetPlayer);

    this.debugLog('play:start', {
      songId: song.id,
      title: song.title,
      activePlayer: this.activePlayer,
      targetPlayer,
      shouldSwapPlayersForBackgroundTrackChange,
      currentAudio: this.describeAudio(this.getActiveAudio(), this.activePlayer),
      targetAudio: this.describeAudio(audio, targetPlayer),
    });

    if (shouldSwapPlayersForBackgroundTrackChange) {
      // iOS background playback is more reliable when the new track is staged
      // on the inactive element and swapped in after playback starts.
      this.internalPause = true;
      audio.pause();
      audio.src = '';
      audio.load();
      this.internalPause = false;
    } else {
      // Pause current audio before changing src to prevent spurious 'ended' events
      this.internalPause = true;
      this.getActiveAudio().pause();
      this.internalPause = false;
    }

    const quality = uiState.streamQuality;
    const url = getSubsonicClient().stream(song.id, quality || undefined);

    this.configureAudioSession();
    this.currentReplayGainMultiplier = 1;
    audio.src = url;
    audio.load();
    this.applyElementVolume();

    // Reset scrobble tracking
    this.scrobbled = false;

    try {
      await audio.play();
      this.debugLog('play:resolved', {
        songId: song.id,
        targetPlayer,
        targetAudio: this.describeAudio(audio, targetPlayer),
      });
    } catch (err) {
      // AbortError is expected when a new play() call interrupts a pending one — ignore it
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (shouldSwapPlayersForBackgroundTrackChange) {
        this.internalPause = true;
        audio.pause();
        audio.src = '';
        audio.load();
        this.internalPause = false;
      }
      this.debugLog('play:rejected', {
        songId: song.id,
        targetPlayer,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        targetAudio: this.describeAudio(audio, targetPlayer),
      });
      console.error('[PlaybackManager] Play error:', err);
      usePlayerStore.getState().setPlaying(false);
      return;
    }

    // Bail if another play() was called while we were awaiting
    if (thisPlayId !== this.playId) {
      if (shouldSwapPlayersForBackgroundTrackChange) {
        this.internalPause = true;
        audio.pause();
        audio.src = '';
        audio.load();
        this.internalPause = false;
      }
      return;
    }

    if (shouldSwapPlayersForBackgroundTrackChange) {
      const previousActiveAudio = this.getActiveAudio();
      this.activePlayer = targetPlayer;
      this.internalPause = true;
      previousActiveAudio.pause();
      previousActiveAudio.src = '';
      previousActiveAudio.load();
      this.internalPause = false;
      if (!isNaN(audio.duration)) {
        usePlayerStore.getState().setDuration(Math.round(audio.duration * 1000));
      }
      this.applyElementVolume();
      this.debugLog('play:swapped-active-player', {
        newActivePlayer: this.activePlayer,
        activeAudio: this.describeAudio(this.getActiveAudio(), this.activePlayer),
        previousAudio: this.describeAudio(previousActiveAudio, this.activePlayer === 'A' ? 'B' : 'A'),
      });
    }

    // Send "now playing" notification so the server shows this session
    getSubsonicClient().scrobble(song.id, false).catch(() => {});

    // Connect to Web Audio graph after first successful play.
    // On subsequent plays crossOrigin is already set so no re-fetch.
    if (!this.backgroundSafeMode && !this.sourceA) {
      this.ensureAudioChain();
    }

    // Set active gain to full, inactive to zero — use setTargetAtTime to avoid clicks
    const activeGain = this.activePlayer === 'A' ? this.gainA : this.gainB;
    const inactiveGain = this.activePlayer === 'A' ? this.gainB : this.gainA;
    const now = this.audioContext?.currentTime ?? 0;
    if (activeGain) {
      activeGain.gain.cancelScheduledValues(now);
      activeGain.gain.setTargetAtTime(this.currentVolume, now, 0.02);
    }
    if (inactiveGain) {
      inactiveGain.gain.cancelScheduledValues(now);
      inactiveGain.gain.setTargetAtTime(0, now, 0.02);
    }

    this.applyReplayGain(song);
    this.updateMediaSession(song);
    this.setMediaSessionPlaybackState('playing');
    this.startPositionTracking();
  }

  pause(): void {
    this.debugLog('pause:requested', {
      currentSongId: usePlayerStore.getState().currentSong?.id,
      activeAudio: this.describeAudio(this.getActiveAudio(), this.activePlayer),
    });
    if (useUIStore.getState().castConnected) {
      getCastManager().pause();
    } else {
      this.internalPause = true;
      this.getActiveAudio().pause();
      this.internalPause = false;
    }
    this.setMediaSessionPlaybackState('paused');
    this.updateMediaSessionPosition();
    this.stopPositionTracking();
    this.debugLog('pause:completed', {
      activeAudio: this.describeAudio(this.getActiveAudio(), this.activePlayer),
    });
  }

  async resume(): Promise<void> {
    this.debugLog('resume:requested', {
      currentSongId: usePlayerStore.getState().currentSong?.id,
      activeAudio: this.describeAudio(this.getActiveAudio(), this.activePlayer),
    });
    if (useUIStore.getState().castConnected) {
      getCastManager().play();
      this.setMediaSessionPlaybackState('playing');
      this.startPositionTracking();
      this.debugLog('resume:cast');
      return;
    }
    this.configureAudioSession();
    this.applyElementVolume();
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
      this.debugLog('resume:audio-context-resumed', {
        audioContextState: this.audioContext.state,
      });
    }
    try {
      await this.getActiveAudio().play();
      this.debugLog('resume:resolved', {
        activeAudio: this.describeAudio(this.getActiveAudio(), this.activePlayer),
      });
    } catch (err) {
      this.debugLog('resume:rejected', {
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        activeAudio: this.describeAudio(this.getActiveAudio(), this.activePlayer),
      });
      console.error('[PlaybackManager] Resume error:', err);
    }
    this.setMediaSessionPlaybackState('playing');
    this.updateMediaSessionPosition();
    this.startPositionTracking();
  }

  hasSource(): boolean {
    return !!this.getActiveAudio().src && this.getActiveAudio().src !== window.location.href;
  }

  async playRadio(streamUrl: string): Promise<void> {
    const thisRadioId = ++this.radioPlayId;

    // Stop EVERYTHING first
    this.stopRadio();
    this.cancelCrossfade();
    this.stopPositionTracking();

    // Stop both song audio elements completely
    this.internalPause = true;
    this.playerA.pause();
    this.playerA.src = '';
    this.playerB.pause();
    this.playerB.src = '';
    this.internalPause = false;

    // Resolve PLS/M3U
    const resolvedUrl = await this.resolveRadioUrl(streamUrl);
    if (thisRadioId !== this.radioPlayId) return; // stale

    const audio = new Audio(resolvedUrl);
    this.configureAudioSession();
    this.currentReplayGainMultiplier = 1;
    audio.volume = this.currentVolume;
    audio.addEventListener('playing', () => {
      if (this.radioAudio !== audio) return;
      this.setMediaSessionPlaybackState('playing');
    });
    audio.addEventListener('pause', () => {
      if (this.radioAudio !== audio || this.internalPause) return;
      this.setMediaSessionPlaybackState('paused');
    });
    audio.addEventListener('error', () => {
      if (this.radioPlayId !== thisRadioId) return;
      console.error('[PlaybackManager] Radio stream error');
      usePlayerStore.getState().stopRadio();
    });

    try {
      await audio.play();
      if (thisRadioId !== this.radioPlayId) {
        audio.pause();
        audio.src = '';
        return;
      }
      this.radioAudio = audio;
      this.updateRadioMediaSession(usePlayerStore.getState().radioMode);
      this.setMediaSessionPlaybackState('playing');
    } catch (err) {
      if (thisRadioId !== this.radioPlayId) return;
      console.error('[PlaybackManager] Radio play error:', err);
      usePlayerStore.getState().stopRadio();
    }
  }

  stopRadio(): void {
    if (this.radioAudio) {
      this.radioAudio.pause();
      this.radioAudio.src = '';
      this.radioAudio = null;
    }
    this.clearMediaSession();
  }

  pauseRadio(): void {
    if (this.radioAudio) {
      this.radioAudio.pause();
    }
    this.setMediaSessionPlaybackState('paused');
  }

  resumeRadio(): void {
    this.configureAudioSession();
    if (this.radioAudio) {
      this.radioAudio.volume = Math.max(0, Math.min(1, this.currentVolume));
      this.radioAudio.play().catch(() => { /* ignore */ });
    }
    this.setMediaSessionPlaybackState('playing');
  }

  private async resolveRadioUrl(url: string): Promise<string> {
    const lower = url.toLowerCase();
    if (!lower.endsWith('.pls') && !lower.endsWith('.m3u') && !lower.endsWith('.m3u8')) {
      return url;
    }

    try {
      const response = await fetch(url);
      const text = await response.text();

      if (lower.endsWith('.pls')) {
        const match = text.match(/File\d+=(.+)/i);
        if (match) return match[1].trim();
      }

      if (lower.endsWith('.m3u') || lower.endsWith('.m3u8')) {
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
            return trimmed;
          }
        }
      }
    } catch { /* fallback */ }

    return url;
  }

  seek(timeMs: number): void {
    if (useUIStore.getState().castConnected) {
      getCastManager().seek(timeMs / 1000);
    } else {
      this.getActiveAudio().currentTime = timeMs / 1000;
    }
    usePlayerStore.getState().setPosition(timeMs);
    this.updateMediaSessionPosition();
  }

  getPosition(): number {
    if (useUIStore.getState().castConnected) {
      return getCastManager().getCurrentTime();
    }
    return this.getActiveAudio().currentTime;
  }

  getVolume(): number {
    return this.currentVolume;
  }

  toggleMute(): void {
    if (this.currentVolume > 0) {
      this.previousVolume = this.currentVolume;
      this.setVolume(0);
    } else {
      this.setVolume(this.previousVolume || 1);
    }
  }

  setVolume(volume: number): void {
    this.currentVolume = Math.max(0, Math.min(1, volume));
    const activeGain = this.activePlayer === 'A' ? this.gainA : this.gainB;
    if (activeGain && !this.crossfading) {
      const now = this.audioContext?.currentTime ?? 0;
      activeGain.gain.cancelScheduledValues(now);
      activeGain.gain.setTargetAtTime(this.currentVolume, now, 0.02);
    }
    // Also update radio audio volume
    if (this.radioAudio) {
      this.radioAudio.volume = this.currentVolume;
    }
    // Also update cast volume
    if (useUIStore.getState().castConnected) {
      getCastManager().setVolume(this.currentVolume);
    }

    this.applyElementVolume();
  }

  setPlaybackRate(rate: number): void {
    this.playerA.playbackRate = rate;
    this.playerB.playbackRate = rate;
    if (this.radioAudio) {
      this.radioAudio.playbackRate = rate;
    }
    this.updateMediaSessionPosition();
  }

  updateEQ(bands: number[], enabled: boolean): void {
    if (this.backgroundSafeMode) return;
    if (this.eqFilters.length !== 10) return;

    for (let i = 0; i < 10; i++) {
      this.eqFilters[i].gain.value = enabled ? Math.max(-12, Math.min(12, bands[i] ?? 0)) : 0;
    }
  }

  getAnalyser(): AnalyserNode | null {
    if (this.backgroundSafeMode) return null;
    return this.analyser;
  }

  startSleepTimer(minutes: number): void {
    this.cancelSleepTimer();
    this.sleepRemainingMs = minutes * 60 * 1000;

    this.sleepTimerId = window.setInterval(() => {
      this.sleepRemainingMs -= 1000;

      if (this.sleepRemainingMs <= 0) {
        // Time's up, pause
        this.pause();
        usePlayerStore.getState().setPlaying(false);
        this.setVolume(this.currentVolume); // restore volume reference
        this.cancelSleepTimer();
        return;
      }

      // Fade during last N seconds (configurable, default 10s)
      const fadeSec = useUIStore.getState().sleepFadeDuration ?? 10;
      if (this.sleepRemainingMs <= fadeSec * 1000) {
        const linear = this.sleepRemainingMs / (fadeSec * 1000);
        const fraction = linear * linear; // exponential curve for natural-sounding fade
        const activeGain = this.activePlayer === 'A' ? this.gainA : this.gainB;
        if (activeGain) {
          activeGain.gain.value = this.currentVolume * fraction;
        }
      }
    }, 1000);
  }

  cancelSleepTimer(): void {
    if (this.sleepTimerId !== null) {
      clearInterval(this.sleepTimerId);
      this.sleepTimerId = null;
    }
    if (this.sleepFadeInterval !== null) {
      clearInterval(this.sleepFadeInterval);
      this.sleepFadeInterval = null;
    }
    this.sleepRemainingMs = 0;
    // Restore volume
    const activeGain = this.activePlayer === 'A' ? this.gainA : this.gainB;
    if (activeGain) {
      activeGain.gain.value = this.currentVolume;
    }
  }

  destroy(): void {
    this.stopRadio();
    this.stopPositionTracking();
    this.cancelCrossfade();
    this.cancelSleepTimer();

    if (this.unsubscribeEQ) {
      this.unsubscribeEQ();
      this.unsubscribeEQ = null;
    }

    this.playerA.pause();
    this.playerA.src = '';
    this.playerB.pause();
    this.playerB.src = '';

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.sourceA = null;
    this.sourceB = null;
    this.gainA = null;
    this.gainB = null;
    this.eqFilters = [];
    this.analyser = null;

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pageshow', this.pageShowHandler);
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private getActiveAudio(): HTMLAudioElement {
    return this.activePlayer === 'A' ? this.playerA : this.playerB;
  }

  private getInactiveAudio(): HTMLAudioElement {
    return this.activePlayer === 'A' ? this.playerB : this.playerA;
  }

  private getAudioForPlayer(player: 'A' | 'B'): HTMLAudioElement {
    return player === 'A' ? this.playerA : this.playerB;
  }

  private setupAudioChain(): void {
    const ctx = this.audioContext!;

    // createMediaElementSource can only be called once per HTMLAudioElement.
    // If sources already exist (e.g. React StrictMode re-mount), reuse them.
    if (!this.sourceA) {
      this.sourceA = ctx.createMediaElementSource(this.playerA);
    }
    if (!this.sourceB) {
      this.sourceB = ctx.createMediaElementSource(this.playerB);
    }

    // Per-player gain nodes (for crossfade volume control)
    this.gainA = ctx.createGain();
    this.gainB = ctx.createGain();
    this.gainA.gain.value = this.currentVolume;
    this.gainB.gain.value = 0;

    // Connect sources to their gain nodes
    this.sourceA.connect(this.gainA);
    this.sourceB.connect(this.gainB);

    // Create 10-band EQ (shared chain)
    this.eqFilters = EQ_FREQUENCIES.map((freq) => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = EQ_Q;
      filter.gain.value = 0;
      return filter;
    });

    // Create analyser (shared, for visualizer)
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    // Chain: gainA/gainB → EQ[0] → EQ[1] → ... → EQ[9] → analyser → destination
    // Both gains feed into the first EQ filter
    this.gainA.connect(this.eqFilters[0]);
    this.gainB.connect(this.eqFilters[0]);

    // Chain EQ filters together
    for (let i = 0; i < this.eqFilters.length - 1; i++) {
      this.eqFilters[i].connect(this.eqFilters[i + 1]);
    }

    // Limiter to prevent clipping when EQ boosts signal above 0dB
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;   // Start compressing at -1dB
    this.limiter.knee.value = 0;         // Hard knee
    this.limiter.ratio.value = 20;       // Heavy compression (acts as limiter)
    this.limiter.attack.value = 0.001;   // Fast attack
    this.limiter.release.value = 0.1;    // Quick release

    // Last EQ → limiter → analyser → destination
    this.eqFilters[this.eqFilters.length - 1].connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  private startPositionTracking(): void {
    this.stopPositionTracking();

    let lastUpdate = 0;
    const tick = () => {
      const now = performance.now();
      const shouldUpdate = now - lastUpdate >= POSITION_UPDATE_MS;

      if (useUIStore.getState().castConnected) {
        // Local audio is silent during cast — pull position from the cast SDK.
        // Crossfade/gapless preload don't apply to single-track cast sessions.
        if (shouldUpdate) {
          lastUpdate = now;
          const positionMs = Math.round(getCastManager().getCurrentTime() * 1000);
          usePlayerStore.getState().setPosition(positionMs);
          this.checkScrobble();
        }
      } else {
        const audio = this.getActiveAudio();
        if (!audio.paused && !audio.ended && shouldUpdate) {
          lastUpdate = now;
          const positionMs = Math.round(audio.currentTime * 1000);
          usePlayerStore.getState().setPosition(positionMs);
          this.checkScrobble();
          this.checkCrossfadeStart();
          this.checkGaplessPreload();
        }
      }

      if (this.positionTimerType === 'raf') {
        this.positionInterval = window.requestAnimationFrame(tick);
      }
    };

    if (this.backgroundSafeMode) {
      this.positionTimerType = 'interval';
      this.positionInterval = window.setInterval(tick, POSITION_UPDATE_MS);
      tick();
      return;
    }

    this.positionTimerType = 'raf';
    this.positionInterval = window.requestAnimationFrame(tick);
  }

  private stopPositionTracking(): void {
    if (this.positionInterval !== null) {
      if (this.positionTimerType === 'interval') {
        clearInterval(this.positionInterval);
      } else {
        cancelAnimationFrame(this.positionInterval);
      }
      this.positionInterval = null;
    }
    this.positionTimerType = null;
  }

  private checkScrobble(): void {
    if (this.scrobbled) return;

    const state = usePlayerStore.getState();
    const song = state.currentSong;
    if (!song) return;

    let playedSeconds: number;
    let durationSeconds: number;
    if (useUIStore.getState().castConnected) {
      playedSeconds = getCastManager().getCurrentTime();
      durationSeconds = song.duration ?? NaN;
    } else {
      const audio = this.getActiveAudio();
      playedSeconds = audio.currentTime;
      durationSeconds = audio.duration;
    }

    if (isNaN(durationSeconds) || durationSeconds <= 0) return;

    const threshold = Math.min(SCROBBLE_MIN_SECONDS, durationSeconds * SCROBBLE_PERCENT);

    if (playedSeconds >= threshold) {
      this.scrobbled = true;

      // Submit scrobble (fire and forget)
      getSubsonicClient().scrobble(song.id, true).catch((err) => {
        console.error('[PlaybackManager] Scrobble error:', err);
      });

      // Log to local play history for smart playlists
      import('../stores/playHistoryStore').then(({ logPlay }) => {
        logPlay({ songId: song.id, title: song.title, artist: song.artist, album: song.album, timestamp: Date.now() });
      });
    }
  }

  private checkCrossfadeStart(): void {
    if (this.backgroundSafeMode) return;
    const state = usePlayerStore.getState();
    if (!state.crossfadeEnabled || this.crossfading) return;

    const audio = this.getActiveAudio();
    const remaining = (audio.duration - audio.currentTime) / (audio.playbackRate || 1);

    if (isNaN(remaining)) return;

    if (remaining <= state.crossfadeDuration && remaining > 0) {
      // Determine next song
      const { queue, currentIndex, shuffleEnabled, shuffleOrder, repeatMode } = state;
      if (queue.length <= 1 && repeatMode !== 'one' && repeatMode !== 'all') return;

      let nextIndex: number;
      if (repeatMode === 'one') {
        // No crossfade for repeat-one, just let it end and restart
        return;
      }

      if (shuffleEnabled && shuffleOrder.length > 0) {
        const shufflePos = shuffleOrder.indexOf(currentIndex);
        const nextShufflePos = shufflePos + 1;
        if (nextShufflePos >= shuffleOrder.length) {
          if (repeatMode === 'all') {
            nextIndex = shuffleOrder[0];
          } else {
            return;
          }
        } else {
          nextIndex = shuffleOrder[nextShufflePos];
        }
      } else {
        nextIndex = currentIndex + 1;
        if (nextIndex >= queue.length) {
          if (repeatMode === 'all') {
            nextIndex = 0;
          } else {
            return;
          }
        }
      }

      const nextSong = queue[nextIndex];
      if (nextSong) {
        this.startCrossfade(nextSong, nextIndex, state.crossfadeDuration);
      }
    }
  }

  private startCrossfade(nextSong: Song, nextIndex: number, duration: number): void {
    if (this.backgroundSafeMode) return;
    this.crossfading = true;

    const inactiveAudio = this.getInactiveAudio();
    const activeGain = this.activePlayer === 'A' ? this.gainA : this.gainB;
    const inactiveGain = this.activePlayer === 'A' ? this.gainB : this.gainA;

    if (!activeGain || !inactiveGain) return;

    // Load next track on inactive player
    const url = getSubsonicClient().stream(nextSong.id);
    inactiveAudio.src = url;
    inactiveAudio.crossOrigin = 'anonymous';

    inactiveAudio.play().catch((err) => {
      console.error('[PlaybackManager] Crossfade play error:', err);
      this.crossfading = false;
      return;
    });

    // Ramp gains using Web Audio API
    const now = this.audioContext!.currentTime;
    activeGain.gain.setValueAtTime(this.currentVolume, now);
    activeGain.gain.linearRampToValueAtTime(0, now + duration);
    inactiveGain.gain.setValueAtTime(0, now);
    inactiveGain.gain.linearRampToValueAtTime(this.currentVolume, now + duration);

    // After crossfade completes, swap players
    this.crossfadeTimer = window.setTimeout(() => {
      // Stop old player
      this.getActiveAudio().pause();
      this.getActiveAudio().src = '';

      // Swap active player
      this.activePlayer = this.activePlayer === 'A' ? 'B' : 'A';
      this.crossfading = false;
      this.crossfadeTimer = null;

      // Reset scrobble tracking for new song
      this.scrobbled = false;

      // Update store to reflect the new song (without triggering another play)
      const store = usePlayerStore.getState();
      store.setPosition(0);
      // Update current index/song directly via skipToIndex
      // We use internal set to avoid re-triggering play from the hook
      usePlayerStore.setState({
        currentIndex: nextIndex,
        currentSong: nextSong,
        isPlaying: true,
        positionMs: 0,
      });

      this.applyReplayGain(nextSong);
      this.updateMediaSession(nextSong);
    }, duration * 1000);
  }

  private cancelCrossfade(): void {
    if (this.backgroundSafeMode) return;
    if (this.crossfadeTimer !== null) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
    this.crossfading = false;

    // Stop inactive player
    const inactive = this.getInactiveAudio();
    inactive.pause();
    inactive.src = '';

    // Reset inactive gain
    const inactiveGain = this.activePlayer === 'A' ? this.gainB : this.gainA;
    if (inactiveGain) {
      inactiveGain.gain.cancelScheduledValues(0);
      inactiveGain.gain.value = 0;
    }

    // Reset active gain smoothly
    const activeGain = this.activePlayer === 'A' ? this.gainA : this.gainB;
    if (activeGain) {
      const now = this.audioContext?.currentTime ?? 0;
      activeGain.gain.cancelScheduledValues(now);
      activeGain.gain.setTargetAtTime(this.currentVolume, now, 0.02);
    }
  }

  private applyReplayGain(song: Song): void {
    const gainMultiplier = this.getReplayGainMultiplier(song);
    this.currentReplayGainMultiplier = gainMultiplier;

    const activeGain = this.activePlayer === 'A' ? this.gainA : this.gainB;
    if (activeGain) {
      const now = this.audioContext?.currentTime ?? 0;
      activeGain.gain.cancelScheduledValues(now);
      activeGain.gain.setTargetAtTime(this.currentVolume * gainMultiplier, now, 0.02);
    }

    this.applyElementVolume();
  }

  private updateMediaSession(song: Song): void {
    if (!('mediaSession' in navigator)) return;

    const client = getSubsonicClient();
    const artwork: MediaImage[] = [];
    if (song.coverArt) {
      artwork.push(
        { src: client.getCoverArt(song.coverArt, 96), sizes: '96x96', type: 'image/jpeg' },
        { src: client.getCoverArt(song.coverArt, 256), sizes: '256x256', type: 'image/jpeg' },
        { src: client.getCoverArt(song.coverArt, 512), sizes: '512x512', type: 'image/jpeg' },
      );
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist ?? 'Unknown Artist',
      album: song.album ?? 'Unknown Album',
      artwork,
    });

    this.setMediaSessionActionHandler('play', () => {
      this.debugLog('media-session:play', {
        activeAudio: this.describeAudio(this.getActiveAudio(), this.activePlayer),
      });
      void this.resume();
      usePlayerStore.getState().setPlaying(true);
    });

    this.setMediaSessionActionHandler('pause', () => {
      this.debugLog('media-session:pause', {
        activeAudio: this.describeAudio(this.getActiveAudio(), this.activePlayer),
      });
      this.pause();
      usePlayerStore.getState().setPlaying(false);
    });

    this.setMediaSessionActionHandler('previoustrack', () => {
      usePlayerStore.getState().previous();
    });

    this.setMediaSessionActionHandler('nexttrack', () => {
      usePlayerStore.getState().next();
    });

    this.setMediaSessionActionHandler('seekto', (details) => {
      if (details.seekTime != null) {
        this.seek(details.seekTime * 1000);
      }
    });

    this.setMediaSessionActionHandler('seekforward', (details) => {
      const skipTime = details.seekOffset ?? 10;
      const audio = this.getActiveAudio();
      this.seek(Math.min((audio.currentTime + skipTime) * 1000, (audio.duration || 0) * 1000));
    });

    this.setMediaSessionActionHandler('seekbackward', (details) => {
      const skipTime = details.seekOffset ?? 10;
      const audio = this.getActiveAudio();
      this.seek(Math.max((audio.currentTime - skipTime) * 1000, 0));
    });

    this.updateMediaSessionPosition();
  }

  private handleTrackEnded(player: 'A' | 'B'): void {
    // Only handle if this is the active player and not crossfading
    if (player !== this.activePlayer || this.crossfading) return;
    // Don't advance queue if radio is active (src was cleared for radio)
    if (this.radioAudio) return;
    // Don't handle if the source was cleared (manual skip triggers ended event)
    const audio = player === 'A' ? this.playerA : this.playerB;
    if (!audio.src || audio.src === window.location.href) return;

    // Guard against premature `ended` from a truncated stream (transcoder
    // closed early, network blip on a chunked response). Only treat as
    // premature when we're well below the end on both an absolute and
    // relative basis — otherwise tracks with slightly-off metadata get stuck.
    if (
      !isNaN(audio.duration) && audio.duration > 0 &&
      audio.duration - audio.currentTime > 5 &&
      audio.currentTime / audio.duration < 0.95
    ) {
      console.warn(`[PlaybackManager] Premature ended at ${audio.currentTime.toFixed(1)}/${audio.duration.toFixed(1)}s — stopping in place instead of auto-skip`);
      this.stopPositionTracking();
      usePlayerStore.getState().setPlaying(false);
      return;
    }

    this.stopPositionTracking();

    const state = usePlayerStore.getState();
    if (state.repeatMode === 'one') {
      // Restart current track
      const audio = this.getActiveAudio();
      audio.currentTime = 0;
      audio.play().catch((err) => {
        console.error('[PlaybackManager] Repeat-one replay error:', err);
      });
      this.scrobbled = false;
      this.startPositionTracking();
      return;
    }

    // Gapless: if next track is preloaded on inactive player, swap instantly
    if (this.preloadedSongId && state.gaplessEnabled && !state.crossfadeEnabled) {
      const nextSong = state.queue[this.preloadedIndex];
      if (nextSong && nextSong.id === this.preloadedSongId) {
        const inactiveAudio = this.getInactiveAudio();
        inactiveAudio.play().catch((err) => {
          console.error('[PlaybackManager] Gapless play error:', err);
        });

        // Stop old player
        this.internalPause = true;
        this.getActiveAudio().pause();
        this.getActiveAudio().src = '';
        this.internalPause = false;

        // Save index before clearing
        const nextIndex = this.preloadedIndex;

        // Swap active player
        this.activePlayer = this.activePlayer === 'A' ? 'B' : 'A';
        this.scrobbled = false;
        this.preloadedSongId = null;
        this.preloadedIndex = -1;

        // Set gains
        const activeGain = this.activePlayer === 'A' ? this.gainA : this.gainB;
        const inactiveGain = this.activePlayer === 'A' ? this.gainB : this.gainA;
        const now = this.audioContext?.currentTime ?? 0;
        if (activeGain) {
          activeGain.gain.cancelScheduledValues(now);
          activeGain.gain.setTargetAtTime(this.currentVolume, now, 0.005);
        }
        if (inactiveGain) {
          inactiveGain.gain.cancelScheduledValues(now);
          inactiveGain.gain.setTargetAtTime(0, now, 0.005);
        }

        // Update store directly to avoid re-triggering play from the hook
        usePlayerStore.setState({
          currentIndex: nextIndex,
          currentSong: nextSong,
          isPlaying: true,
          positionMs: 0,
        });

        this.applyReplayGain(nextSong);
        this.updateMediaSession(nextSong);
        this.startPositionTracking();

        // Send scrobble
        getSubsonicClient().scrobble(nextSong.id, false).catch(() => {});
        return;
      }
    }

    // Fallback: normal next
    state.next();
  }

  private clearPreload(): void {
    if (this.preloadedSongId) {
      const inactive = this.getInactiveAudio();
      inactive.pause();
      inactive.src = '';
      inactive.load();
      this.preloadedSongId = null;
      this.preloadedIndex = -1;
    }
  }

  private checkGaplessPreload(): void {
    if (this.backgroundSafeMode) return;
    const state = usePlayerStore.getState();
    // Only preload if gapless enabled, crossfade disabled, not already preloaded, not crossfading
    if (!state.gaplessEnabled || state.crossfadeEnabled || this.crossfading || this.preloadedSongId) return;

    const audio = this.getActiveAudio();
    // Don't preload if active player has no real source (e.g., between plays)
    if (!audio.src || audio.src === window.location.href) return;
    const remaining = audio.duration - audio.currentTime;
    if (isNaN(remaining) || remaining > 15 || remaining <= 0) return;

    // Determine next song (same logic as crossfade)
    const { queue, currentIndex, shuffleEnabled, shuffleOrder, repeatMode } = state;
    if (queue.length <= 1 && repeatMode !== 'all') return;
    if (repeatMode === 'one') return;

    let nextIndex: number;
    if (shuffleEnabled && shuffleOrder.length > 0) {
      const shufflePos = shuffleOrder.indexOf(currentIndex);
      const nextShufflePos = shufflePos + 1;
      if (nextShufflePos >= shuffleOrder.length) {
        if (repeatMode === 'all') nextIndex = shuffleOrder[0];
        else return;
      } else {
        nextIndex = shuffleOrder[nextShufflePos];
      }
    } else {
      nextIndex = currentIndex + 1;
      if (nextIndex >= queue.length) {
        if (repeatMode === 'all') nextIndex = 0;
        else return;
      }
    }

    const nextSong = queue[nextIndex];
    if (!nextSong) return;

    // Preload on inactive player
    const inactive = this.getInactiveAudio();
    const url = getSubsonicClient().stream(nextSong.id);
    inactive.src = url;
    inactive.preload = 'auto';
    inactive.load();
    this.preloadedSongId = nextSong.id;
    this.preloadedIndex = nextIndex;
  }

  private handleError(player: 'A' | 'B'): void {
    if (player !== this.activePlayer) return;
    if (this.radioAudio) return;
    // Ignore errors from empty/cleared sources
    const audio = player === 'A' ? this.playerA : this.playerB;
    if (!audio.src || audio.src === window.location.href) return;
    this.debugLog('audio:error', {
      player,
      audio: this.describeAudio(audio, player),
    });
    console.error(`[PlaybackManager] Audio error on player ${player}`);
    usePlayerStore.getState().setPlaying(false);
  }

  private handleExternalPause(player: 'A' | 'B'): void {
    if (player !== this.activePlayer || this.crossfading || this.internalPause) return;
    const audio = player === 'A' ? this.playerA : this.playerB;
    // Ignore pauses caused by clearing src or by the natural end-of-track
    if (!audio.src || audio.src === window.location.href || audio.ended) return;
    this.debugLog('audio:external-pause', {
      player,
      audio: this.describeAudio(audio, player),
      storeIsPlaying: usePlayerStore.getState().isPlaying,
    });
    // If the store thinks we're still playing, the pause came from outside
    // (OS focus loss, Bluetooth dropout, buffer underrun). Reflect it in UI.
    if (usePlayerStore.getState().isPlaying) {
      usePlayerStore.getState().setPlaying(false);
    }
    this.setMediaSessionPlaybackState('paused');
    this.updateMediaSessionPosition();
  }

  private async handleCastSessionEnded(lastPositionMs: number): Promise<void> {
    // CastManager has already flipped castConnected → false by the time this fires,
    // so the local-playback path below won't bounce back into the cast branch.
    const state = usePlayerStore.getState();
    const song = state.currentSong;
    if (!song || !state.isPlaying) return;

    const thisPlayId = ++this.playId;

    this.cancelCrossfade();
    this.clearPreload();
    this.internalPause = true;
    this.getActiveAudio().pause();
    this.internalPause = false;

    const audio = this.getActiveAudio();
    const quality = useUIStore.getState().streamQuality;
    const url = getSubsonicClient().stream(song.id, quality || undefined);
    audio.src = url;
    audio.load();

    // Seek to the last cast position once metadata is available.
    audio.addEventListener(
      'loadedmetadata',
      () => {
        if (thisPlayId === this.playId) {
          audio.currentTime = lastPositionMs / 1000;
        }
      },
      { once: true },
    );

    this.scrobbled = false;

    try {
      await audio.play();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[PlaybackManager] Cast handoff resume error:', err);
      usePlayerStore.getState().setPlaying(false);
      return;
    }

    if (thisPlayId !== this.playId) return;

    if (!this.sourceA) this.ensureAudioChain();

    const activeGain = this.activePlayer === 'A' ? this.gainA : this.gainB;
    const inactiveGain = this.activePlayer === 'A' ? this.gainB : this.gainA;
    const now = this.audioContext?.currentTime ?? 0;
    if (activeGain) {
      activeGain.gain.cancelScheduledValues(now);
      activeGain.gain.setTargetAtTime(this.currentVolume, now, 0.02);
    }
    if (inactiveGain) {
      inactiveGain.gain.cancelScheduledValues(now);
      inactiveGain.gain.setTargetAtTime(0, now, 0.02);
    }

    this.applyReplayGain(song);
    this.updateMediaSession(song);
    this.setMediaSessionPlaybackState('playing');
    this.startPositionTracking();
  }

  private handleMetadata(player: 'A' | 'B'): void {
    if (player !== this.activePlayer || this.crossfading) return;
    const audio = this.getActiveAudio();
    if (!isNaN(audio.duration)) {
      usePlayerStore.getState().setDuration(Math.round(audio.duration * 1000));
    }
    this.updateMediaSessionPosition();
  }

  private handleTimeUpdate(player: 'A' | 'B'): void {
    if (player !== this.activePlayer || this.crossfading) return;
    this.updateMediaSessionPosition();
  }

  private handleRateChange(player: 'A' | 'B'): void {
    if (player !== this.activePlayer || this.crossfading) return;
    this.updateMediaSessionPosition();
  }

  private handlePlaying(player: 'A' | 'B'): void {
    if (player !== this.activePlayer) return;
    this.debugLog('audio:playing', {
      player,
      audio: this.describeAudio(this.getActiveAudio(), player),
    });
    this.setMediaSessionPlaybackState('playing');
    this.updateMediaSessionPosition();
  }

  private describeAudio(
    audio: HTMLAudioElement | null,
    player?: 'A' | 'B',
  ): Record<string, unknown> | null {
    if (!audio) return null;

    return {
      player,
      paused: audio.paused,
      ended: audio.ended,
      currentTime: Number.isFinite(audio.currentTime) ? Number(audio.currentTime.toFixed(3)) : audio.currentTime,
      duration: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(3)) : audio.duration,
      readyState: audio.readyState,
      networkState: audio.networkState,
      playbackRate: audio.playbackRate,
      volume: audio.volume,
      muted: audio.muted,
      src: audio.src || null,
    };
  }

  private debugLog(event: string, extra: Record<string, unknown> = {}): void {
    const standalone = isStandalonePWA();
    const visibilityState = typeof document !== 'undefined' ? document.visibilityState : undefined;
    const hidden = typeof document !== 'undefined' ? document.hidden : undefined;

    console.info(`[PlaybackManager][debug] ${event}`, {
      standalone,
      backgroundSafeMode: this.backgroundSafeMode,
      activePlayer: this.activePlayer,
      storeIsPlaying: usePlayerStore.getState().isPlaying,
      currentSongId: usePlayerStore.getState().currentSong?.id ?? null,
      visibilityState,
      hidden,
      ...extra,
    });
  }

  private updateRadioMediaSession(station: RadioState | null): void {
    if (!station || !('mediaSession' in navigator)) return;

    const client = getSubsonicClient();
    const artwork: MediaImage[] = [];
    if (station.coverArt) {
      artwork.push(
        { src: client.getCoverArt(station.coverArt, 96), sizes: '96x96', type: 'image/jpeg' },
        { src: client.getCoverArt(station.coverArt, 256), sizes: '256x256', type: 'image/jpeg' },
        { src: client.getCoverArt(station.coverArt, 512), sizes: '512x512', type: 'image/jpeg' },
      );
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: station.stationName,
      artist: 'Internet Radio',
      album: 'Live Stream',
      artwork,
    });

    this.setMediaSessionActionHandler('play', () => {
      this.resumeRadio();
      usePlayerStore.setState({ radioPlaying: true });
    });
    this.setMediaSessionActionHandler('pause', () => {
      this.pauseRadio();
      usePlayerStore.setState({ radioPlaying: false });
    });
    this.setMediaSessionActionHandler('previoustrack', null);
    this.setMediaSessionActionHandler('nexttrack', null);
    this.setMediaSessionActionHandler('seekto', null);
    this.setMediaSessionActionHandler('seekforward', null);
    this.setMediaSessionActionHandler('seekbackward', null);
    this.clearMediaSessionPosition();
  }

  private setMediaSessionActionHandler(
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null,
  ): void {
    if (!('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Ignore unsupported actions on browsers with partial Media Session support.
    }
  }

  private setMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = state;
  }

  private updateMediaSessionPosition(): void {
    if (!('mediaSession' in navigator)) return;
    if (usePlayerStore.getState().radioMode) {
      this.clearMediaSessionPosition();
      return;
    }

    const mediaSession = navigator.mediaSession as MediaSession & {
      setPositionState?: (state?: MediaPositionState) => void;
    };
    if (typeof mediaSession.setPositionState !== 'function') return;

    const audio = this.getActiveAudio();
    if (!audio.src || audio.src === window.location.href) {
      this.clearMediaSessionPosition();
      return;
    }

    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      this.clearMediaSessionPosition();
      return;
    }

    const position = Math.max(0, Math.min(audio.currentTime || 0, audio.duration));

    try {
      mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position,
      });
    } catch {
      // Safari can reject invalid position-state updates; ignore and keep playback going.
    }
  }

  private clearMediaSessionPosition(): void {
    if (!('mediaSession' in navigator)) return;

    const mediaSession = navigator.mediaSession as MediaSession & {
      setPositionState?: (state?: MediaPositionState) => void;
    };
    if (typeof mediaSession.setPositionState !== 'function') return;

    try {
      mediaSession.setPositionState();
    } catch {
      // Ignore position-state clear failures on partial implementations.
    }
  }

  private clearMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    this.setMediaSessionPlaybackState('none');
    this.clearMediaSessionPosition();
  }

  private getReplayGainMultiplier(song: Song): number {
    if (!song.replayGain) return 1;

    const mode = useUIStore.getState().replayGainMode;
    if (mode === 'off') return 1;

    const gain = mode === 'album'
      ? (song.replayGain.albumGain ?? song.replayGain.trackGain ?? 0)
      : (song.replayGain.trackGain ?? song.replayGain.albumGain ?? 0);

    if (gain === 0) return 1;

    const peak = mode === 'album'
      ? (song.replayGain.albumPeak ?? song.replayGain.trackPeak ?? 1.0)
      : (song.replayGain.trackPeak ?? song.replayGain.albumPeak ?? 1.0);

    let gainMultiplier = Math.pow(10, gain / 20);

    if (gainMultiplier * peak > 1.0) {
      gainMultiplier = 1.0 / peak;
    }

    return gainMultiplier;
  }

  private applyElementVolume(): void {
    if (this.backgroundSafeMode) {
      const volume = Math.max(0, Math.min(1, this.currentVolume * this.currentReplayGainMultiplier));
      this.getActiveAudio().volume = volume;
      this.getInactiveAudio().volume = Math.max(0, Math.min(1, this.currentVolume));
    } else {
      this.getActiveAudio().volume = 1;
      this.getInactiveAudio().volume = 1;
    }

    if (this.radioAudio) {
      this.radioAudio.volume = Math.max(0, Math.min(1, this.currentVolume));
    }
  }

  private configureAudioSession(): void {
    if (typeof navigator === 'undefined') return;

    const audioSessionNavigator = navigator as Navigator & {
      audioSession?: { type?: string };
    };

    try {
      if (audioSessionNavigator.audioSession) {
        audioSessionNavigator.audioSession.type = 'playback';
      }
    } catch {
      // Ignore audio-session configuration failures on unsupported browsers.
    }
  }

  private recoverPlaybackAfterForeground(): void {
    if (this.radioAudio && usePlayerStore.getState().radioPlaying && this.radioAudio.paused) {
      this.radioAudio.play().catch(() => { /* ignore */ });
      return;
    }

    if (!usePlayerStore.getState().isPlaying || !this.hasSource()) return;

    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume().catch(() => { /* ignore */ });
    }

    const audio = this.getActiveAudio();
    if (audio.paused) {
      audio.play().catch(() => { /* ignore */ });
    }
  }
}

// Singleton
let instance: PlaybackManager | null = null;

export function getPlaybackManager(): PlaybackManager {
  if (!instance) {
    instance = new PlaybackManager();
  }
  return instance;
}

export default PlaybackManager;
