import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock CastManager so its singleton is fully controllable.
const mockCast = {
  getCurrentTime: vi.fn(() => 0),
  onSessionEnd: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
  setVolume: vi.fn(),
  loadMedia: vi.fn(async () => {}),
};
vi.mock('./CastManager', () => ({
  getCastManager: () => mockCast,
  default: class {},
}));

// Mock SubsonicClient so PlaybackManager doesn't try to make real network calls.
vi.mock('../api/SubsonicClient', () => ({
  getSubsonicClient: () => ({
    stream: (id: string) => `https://example.test/stream/${id}`,
    getCoverArt: (id: string) => `https://example.test/cover/${id}`,
    scrobble: vi.fn(async () => {}),
  }),
}));

import { useUIStore } from '../stores/uiStore';
import { usePlayerStore } from '../stores/playerStore';
import PlaybackManager from './PlaybackManager';

const mediaSession = {
  metadata: null as MediaMetadata | null,
  playbackState: 'none' as MediaSessionPlaybackState,
  setActionHandler: vi.fn(),
  setPositionState: vi.fn(),
};

type PlaybackManagerTestAccess = {
  activePlayer: 'A' | 'B';
  playerA: HTMLAudioElement;
  playerB: HTMLAudioElement;
  play: (song: {
    id: string;
    title: string;
    artist?: string;
    album?: string;
    coverArt?: string;
  }) => Promise<void>;
  updateMediaSession: (song: {
    id: string;
    title: string;
    artist: string;
    album: string;
    coverArt: string;
  }) => void;
  setMediaSessionPlaybackState: (state: MediaSessionPlaybackState) => void;
  updateRadioMediaSession: (station: {
    stationId: string;
    stationName: string;
    streamUrl: string;
    coverArt: string;
  }) => void;
};

beforeEach(() => {
  mockCast.getCurrentTime.mockReset();
  mockCast.onSessionEnd.mockReset();
  mockCast.seek.mockReset();
  mockCast.pause.mockReset();
  mockCast.play.mockReset();
  mockCast.setVolume.mockReset();
  useUIStore.setState({ castConnected: false });
  mediaSession.metadata = null;
  mediaSession.playbackState = 'none';
  mediaSession.setActionHandler.mockReset();
  mediaSession.setPositionState.mockReset();

  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: mediaSession,
  });

  vi.stubGlobal('MediaMetadata', class MediaMetadata {
    title: string;
    artist: string;
    album: string;
    artwork: MediaImage[];

    constructor(init: MediaMetadataInit) {
      this.title = init.title ?? '';
      this.artist = init.artist ?? '';
      this.album = init.album ?? '';
      this.artwork = init.artwork ?? [];
    }
  });
});

describe('PlaybackManager cast integration', () => {
  it('registers a session-end handler with CastManager on construction', () => {
    new PlaybackManager();
    expect(mockCast.onSessionEnd).toHaveBeenCalledTimes(1);
    expect(typeof mockCast.onSessionEnd.mock.calls[0][0]).toBe('function');
  });

  it('getPosition reads from CastManager when casting', () => {
    const pm = new PlaybackManager();
    useUIStore.setState({ castConnected: true });
    mockCast.getCurrentTime.mockReturnValue(73.5);

    expect(pm.getPosition()).toBe(73.5);
  });

  it('getPosition reads from local audio when not casting', () => {
    const pm = new PlaybackManager();
    useUIStore.setState({ castConnected: false });
    mockCast.getCurrentTime.mockReturnValue(999); // should be ignored

    // Local audio currentTime defaults to 0 with no source loaded.
    expect(pm.getPosition()).toBe(0);
    expect(mockCast.getCurrentTime).not.toHaveBeenCalled();
  });

  it('seek sends to CastManager (in seconds) and skips local audio when casting', () => {
    const pm = new PlaybackManager();
    useUIStore.setState({ castConnected: true });

    pm.seek(12500);

    expect(mockCast.seek).toHaveBeenCalledWith(12.5);
    expect(usePlayerStore.getState().positionMs).toBe(12500);
  });

  it('pause delegates to CastManager when casting (does not pause local audio)', () => {
    const pm = new PlaybackManager();
    useUIStore.setState({ castConnected: true });

    pm.pause();

    expect(mockCast.pause).toHaveBeenCalledTimes(1);
  });

  it('setVolume forwards to CastManager when casting', () => {
    const pm = new PlaybackManager();
    useUIStore.setState({ castConnected: true });

    pm.setVolume(0.4);

    expect(mockCast.setVolume).toHaveBeenCalledWith(0.4);
  });

  it('publishes richer song media session state', () => {
    const pm = new PlaybackManager() as unknown as PlaybackManagerTestAccess;
    const song = {
      id: 'song-1',
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      coverArt: 'cover-1',
    };

    pm.updateMediaSession(song);
    pm.setMediaSessionPlaybackState('playing');

    expect(mediaSession.metadata).toMatchObject({
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
    });
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('play', expect.any(Function));
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('pause', expect.any(Function));
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('nexttrack', expect.any(Function));
    expect(mediaSession.playbackState).toBe('playing');
  });

  it('invokes transport methods for song media-session play and pause actions', async () => {
    const pm = new PlaybackManager() as unknown as PlaybackManagerTestAccess;
    const resumeSpy = vi.spyOn(pm as unknown as { resume: () => Promise<void> }, 'resume')
      .mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(pm as unknown as { pause: () => void }, 'pause')
      .mockImplementation(() => {});
    const song = {
      id: 'song-1',
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      coverArt: 'cover-1',
    };

    pm.updateMediaSession(song);

    const handlers = new Map(
      mediaSession.setActionHandler.mock.calls.map(([action, handler]) => [action, handler]),
    );
    const playHandler = handlers.get('play') as (() => void | Promise<void>) | undefined;
    const pauseHandler = handlers.get('pause') as (() => void) | undefined;

    expect(playHandler).toBeTypeOf('function');
    expect(pauseHandler).toBeTypeOf('function');

    usePlayerStore.setState({ isPlaying: false });
    await playHandler?.();
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    usePlayerStore.setState({ isPlaying: true });
    pauseHandler?.();
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it('publishes radio media session state with transport-only controls', () => {
    const pm = new PlaybackManager() as unknown as PlaybackManagerTestAccess;
    const station = {
      stationId: 'station-1',
      stationName: 'Deep Space FM',
      streamUrl: 'https://example.test/radio',
      coverArt: 'radio-cover',
    };

    pm.updateRadioMediaSession(station);

    expect(mediaSession.metadata).toMatchObject({
      title: 'Deep Space FM',
      artist: 'Internet Radio',
      album: 'Live Stream',
    });
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('play', expect.any(Function));
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('pause', expect.any(Function));
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('nexttrack', null);
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('seekto', null);
  });

  it('stages iOS background track changes on the inactive player and swaps after play starts', async () => {
    const userAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    const platformDescriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
    const touchDescriptor = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    });
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'iPhone',
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 5,
    });

    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});

    try {
      const pm = new PlaybackManager() as unknown as PlaybackManagerTestAccess;
      pm.playerA.src = 'https://example.test/stream/original';
      pm.activePlayer = 'A';

      await pm.play({
        id: 'song-2',
        title: 'Next Track',
        artist: 'Artist',
        album: 'Album',
      });

      expect(pm.activePlayer).toBe('B');
      expect(pm.playerB.src).toContain('/stream/song-2');
      expect(pm.playerA.src).toBe(window.location.href);
      expect(playSpy).toHaveBeenCalled();
      expect(pauseSpy).toHaveBeenCalled();
      expect(loadSpy).toHaveBeenCalled();
    } finally {
      playSpy.mockRestore();
      pauseSpy.mockRestore();
      loadSpy.mockRestore();
      if (userAgentDescriptor) Object.defineProperty(navigator, 'userAgent', userAgentDescriptor);
      if (platformDescriptor) Object.defineProperty(navigator, 'platform', platformDescriptor);
      if (touchDescriptor) Object.defineProperty(navigator, 'maxTouchPoints', touchDescriptor);
    }
  });

  it('swaps to the inactive player when resuming hidden standalone iOS playback without waiting on metadata before play', async () => {
    const userAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    const platformDescriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
    const touchDescriptor = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
    const standaloneDescriptor = Object.getOwnPropertyDescriptor(navigator, 'standalone');
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    });
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'iPhone',
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 5,
    });
    Object.defineProperty(navigator, 'standalone', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});

    try {
      const pm = new PlaybackManager() as unknown as PlaybackManagerTestAccess;
      pm.playerA.src = 'https://example.test/stream/original';
      pm.playerA.currentTime = 42.25;
      pm.playerA.playbackRate = 1.25;
      pm.activePlayer = 'A';

      await (pm as unknown as { resume: () => Promise<void> }).resume();
      pm.playerB.dispatchEvent(new Event('loadedmetadata'));

      expect(pm.activePlayer).toBe('B');
      expect(pm.playerB.src).toContain('/stream/original');
      expect(pm.playerB.currentTime).toBe(42.25);
      expect(pm.playerB.playbackRate).toBe(1.25);
      expect(pm.playerA.src).toBe(window.location.href);
      expect(playSpy).toHaveBeenCalled();
      expect(pauseSpy).toHaveBeenCalled();
      expect(loadSpy).toHaveBeenCalled();
    } finally {
      playSpy.mockRestore();
      pauseSpy.mockRestore();
      loadSpy.mockRestore();
      if (userAgentDescriptor) Object.defineProperty(navigator, 'userAgent', userAgentDescriptor);
      if (platformDescriptor) Object.defineProperty(navigator, 'platform', platformDescriptor);
      if (touchDescriptor) Object.defineProperty(navigator, 'maxTouchPoints', touchDescriptor);
      if (standaloneDescriptor) Object.defineProperty(navigator, 'standalone', standaloneDescriptor);
      else delete (navigator as Navigator & { standalone?: boolean }).standalone;
      if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
      if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
    }
  });
});
