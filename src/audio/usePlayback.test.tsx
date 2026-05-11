import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { playbackManagerMock, syncPositionMock, loadServerQueueMock } = vi.hoisted(() => ({
  playbackManagerMock: {
    warmup: vi.fn(),
    play: vi.fn(async () => {}),
    hasSource: vi.fn(() => false),
    consumePendingStorePlaybackSync: vi.fn(() => false),
    resume: vi.fn(async () => {}),
    pause: vi.fn(),
    seek: vi.fn(),
    setPlaybackRate: vi.fn(),
    updateEQ: vi.fn(),
    getPosition: vi.fn(() => 0),
    getVolume: vi.fn(() => 1),
    toggleMute: vi.fn(),
  },
  syncPositionMock: vi.fn(),
  loadServerQueueMock: vi.fn(),
}));

vi.mock('./PlaybackManager', () => ({
  getPlaybackManager: () => playbackManagerMock,
}));

vi.mock('../api/SubsonicClient', () => ({
  getSubsonicClient: () => ({
    getCoverArt: (id: string) => `https://example.test/cover/${id}`,
  }),
}));

vi.mock('../utils/queueSync', () => ({
  syncPosition: () => syncPositionMock(),
  loadServerQueue: () => loadServerQueueMock(),
}));

import { usePlayback } from './usePlayback';
import { usePlayerStore } from '../stores/playerStore';
import { useUIStore } from '../stores/uiStore';

function makeSong(id: string) {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    duration: 180,
  };
}

describe('usePlayback', () => {
  beforeEach(() => {
    playbackManagerMock.warmup.mockReset();
    playbackManagerMock.play.mockReset();
    playbackManagerMock.play.mockImplementation(async () => {});
    playbackManagerMock.hasSource.mockReset();
    playbackManagerMock.hasSource.mockReturnValue(false);
    playbackManagerMock.consumePendingStorePlaybackSync.mockReset();
    playbackManagerMock.consumePendingStorePlaybackSync.mockReturnValue(false);
    playbackManagerMock.resume.mockReset();
    playbackManagerMock.resume.mockImplementation(async () => {});
    playbackManagerMock.pause.mockReset();
    playbackManagerMock.seek.mockReset();
    playbackManagerMock.setPlaybackRate.mockReset();
    playbackManagerMock.updateEQ.mockReset();
    syncPositionMock.mockReset();
    loadServerQueueMock.mockReset();

    localStorage.clear();
    useUIStore.setState({
      notificationsEnabled: false,
      keyboardShortcutsEnabled: true,
    });
    usePlayerStore.setState({
      queue: [],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      positionMs: 0,
      durationMs: 0,
      radioMode: null,
      radioPlaying: false,
      repeatMode: 'off',
      shuffleEnabled: false,
      shuffleOrder: [],
      playbackSpeed: 1,
      crossfadeEnabled: false,
      crossfadeDuration: 5,
      gaplessEnabled: true,
    });

    vi.stubGlobal('Notification', class Notification {
      static permission = 'denied';
      constructor() {}
    });
  });

  it('plays the newly selected song immediately after a store-driven track change', () => {
    const firstSong = makeSong('1');
    const secondSong = makeSong('2');
    usePlayerStore.setState({
      queue: [firstSong, secondSong],
      currentIndex: 0,
      currentSong: firstSong,
      isPlaying: true,
    });

    renderHook(() => usePlayback());

    act(() => {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    act(() => {
      usePlayerStore.getState().next();
    });

    expect(playbackManagerMock.play).toHaveBeenCalledTimes(1);
    expect(playbackManagerMock.play).toHaveBeenCalledWith(secondSong);
    expect(playbackManagerMock.resume).not.toHaveBeenCalled();
  });

  it('resumes immediately when playback state flips back to playing', () => {
    const song = makeSong('1');
    usePlayerStore.setState({
      queue: [song],
      currentIndex: 0,
      currentSong: song,
      isPlaying: false,
    });
    playbackManagerMock.hasSource.mockReturnValue(true);

    renderHook(() => usePlayback());

    act(() => {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    act(() => {
      usePlayerStore.getState().setPlaying(true);
    });

    expect(playbackManagerMock.resume).toHaveBeenCalledTimes(1);
    expect(playbackManagerMock.play).not.toHaveBeenCalled();
  });

  it('does not issue a duplicate resume when transport already handled the play action', () => {
    const song = makeSong('1');
    usePlayerStore.setState({
      queue: [song],
      currentIndex: 0,
      currentSong: song,
      isPlaying: false,
    });
    playbackManagerMock.hasSource.mockReturnValue(true);
    playbackManagerMock.consumePendingStorePlaybackSync.mockImplementation((isPlaying: boolean) => isPlaying);

    renderHook(() => usePlayback());

    act(() => {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    act(() => {
      usePlayerStore.getState().setPlaying(true);
    });

    expect(playbackManagerMock.consumePendingStorePlaybackSync).toHaveBeenCalledWith(true);
    expect(playbackManagerMock.resume).not.toHaveBeenCalled();
    expect(playbackManagerMock.play).not.toHaveBeenCalled();
  });

  it('pauses and persists position when playback is stopped through the store', () => {
    const song = makeSong('1');
    localStorage.setItem('vibrdrome_queue', JSON.stringify({ positionMs: 10 }));
    usePlayerStore.setState({
      queue: [song],
      currentIndex: 0,
      currentSong: song,
      isPlaying: true,
      positionMs: 4321,
    });

    renderHook(() => usePlayback());

    act(() => {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    act(() => {
      usePlayerStore.getState().setPlaying(false);
    });

    expect(playbackManagerMock.pause).toHaveBeenCalledTimes(1);
    expect(syncPositionMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('vibrdrome_queue') ?? '{}').positionMs).toBe(4321);
  });

  it('persists position without a duplicate pause when transport already handled the pause action', () => {
    const song = makeSong('1');
    localStorage.setItem('vibrdrome_queue', JSON.stringify({ positionMs: 10 }));
    usePlayerStore.setState({
      queue: [song],
      currentIndex: 0,
      currentSong: song,
      isPlaying: true,
      positionMs: 8765,
    });
    playbackManagerMock.consumePendingStorePlaybackSync.mockImplementation((isPlaying: boolean) => !isPlaying);

    renderHook(() => usePlayback());

    act(() => {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    act(() => {
      usePlayerStore.getState().setPlaying(false);
    });

    expect(playbackManagerMock.consumePendingStorePlaybackSync).toHaveBeenCalledWith(false);
    expect(playbackManagerMock.pause).not.toHaveBeenCalled();
    expect(syncPositionMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('vibrdrome_queue') ?? '{}').positionMs).toBe(8765);
  });
});
