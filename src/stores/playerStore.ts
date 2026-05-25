import { create } from 'zustand';
import { getSubsonicClient } from '../api/SubsonicClient';
import { getPlaybackManager } from '../audio/PlaybackManager';
import { useUIStore } from './uiStore';
import { useMusicFolderStore } from './musicFolderStore';
import { prepareAutoplayTail } from '../utils/queueAutoplay';
import type { Song } from '../types/subsonic';

const QUEUE_KEY = 'vibrdrome_queue';
const PLAYER_SETTINGS_KEY = 'vibrdrome_player_settings';

const SPEED_OPTIONS = [1.0, 1.25, 1.5, 2.0, 0.5, 0.75];
let starBusy = false;

function shuffleArray(length: number, currentIndex: number): number[] {
  const indices = Array.from({ length }, (_, i) => i);
  // Fisher-Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  // Move currentIndex to the front so current song stays playing
  const pos = indices.indexOf(currentIndex);
  if (pos > 0) {
    [indices[0], indices[pos]] = [indices[pos], indices[0]];
  }
  return indices;
}

export interface RadioState {
  stationId: string;
  stationName: string;
  streamUrl: string;
  coverArt?: string;
}

type AutoplayStatus = 'idle' | 'loading' | 'ready' | 'fallback' | 'empty';

interface PlaySongsOptions {
  disableAutoplay?: boolean;
}

interface PlaybackState {
  queue: Song[];
  currentIndex: number;
  currentSong: Song | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  radioMode: RadioState | null;
  radioPlaying: boolean;
  repeatMode: 'off' | 'all' | 'one';
  shuffleEnabled: boolean;
  shuffleOrder: number[];
  playbackSpeed: number;
  crossfadeEnabled: boolean;
  crossfadeDuration: number;
  gaplessEnabled: boolean;
  autoplayBaseLength: number | null;
  autoplaySeedSongId: string | null;
  autoplayStatus: AutoplayStatus;
  autoplayRequestKey: string | null;

  playSongs: (songs: Song[], startIndex?: number, options?: PlaySongsOptions) => void;
  playNext: (song: Song) => void;
  addToQueue: (song: Song) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  skipToIndex: (index: number) => void;
  next: () => void;
  previous: () => void;
  togglePlay: () => void;
  setPlaying: (playing: boolean) => void;
  setPosition: (ms: number) => void;
  setDuration: (ms: number) => void;
  seek: (ms: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  cycleSpeed: () => void;
  setSpeed: (speed: number) => void;
  setCrossfade: (enabled: boolean) => void;
  setCrossfadeDuration: (seconds: number) => void;
  setGapless: (enabled: boolean) => void;
  toggleStarCurrent: () => Promise<void>;
  reorderQueue: (from: number, to: number) => void;
  playRadio: (station: RadioState) => void;
  stopRadio: () => void;
}

const DEFAULT_AUTOPLAY_STATE = {
  autoplayBaseLength: null,
  autoplaySeedSongId: null,
  autoplayStatus: 'idle' as const,
  autoplayRequestKey: null,
};

function persistQueue(state: PlaybackState) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({
      queue: state.queue,
      currentIndex: state.currentIndex,
      positionMs: state.positionMs,
      autoplayBaseLength: state.autoplayBaseLength,
      autoplaySeedSongId: state.autoplaySeedSongId,
    }));
  } catch { /* storage full or unavailable */ }

  // Debounced server sync (checks queueSyncEnabled internally)
  try {
    import('../utils/queueSync').then(({ scheduleQueueSync }) => scheduleQueueSync()).catch(() => {});
  } catch { /* ignore in test environments */ }
}

function persistSettings(state: PlaybackState) {
  try {
    localStorage.setItem(PLAYER_SETTINGS_KEY, JSON.stringify({
      repeatMode: state.repeatMode,
      shuffleEnabled: state.shuffleEnabled,
      playbackSpeed: state.playbackSpeed,
      crossfadeEnabled: state.crossfadeEnabled,
      crossfadeDuration: state.crossfadeDuration,
      gaplessEnabled: state.gaplessEnabled,
    }));
  } catch { /* storage full or unavailable */ }
}

function loadPersistedState(): Partial<PlaybackState> {
  try {
    const queueRaw = localStorage.getItem(QUEUE_KEY);
    const settingsRaw = localStorage.getItem(PLAYER_SETTINGS_KEY);
    const queueData = queueRaw ? JSON.parse(queueRaw) : {};
    const settingsData = settingsRaw ? JSON.parse(settingsRaw) : {};

    const queue: Song[] = queueData.queue ?? [];
    const currentIndex: number = queueData.currentIndex ?? -1;
    const currentSong = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

    const positionMs: number = queueData.positionMs ?? 0;
    const autoplayBaseLength = typeof queueData.autoplayBaseLength === 'number' ? queueData.autoplayBaseLength : null;
    const autoplaySeedSongId = typeof queueData.autoplaySeedSongId === 'string' ? queueData.autoplaySeedSongId : null;
    const autoplayStatus: AutoplayStatus = autoplayBaseLength !== null && autoplayBaseLength < queue.length ? 'ready' : 'idle';

    return {
      queue,
      currentIndex,
      currentSong,
      positionMs,
      autoplayBaseLength,
      autoplaySeedSongId,
      autoplayStatus,
      autoplayRequestKey: null,
      repeatMode: settingsData.repeatMode ?? 'off',
      shuffleEnabled: settingsData.shuffleEnabled ?? false,
      playbackSpeed: settingsData.playbackSpeed ?? 1.0,
      crossfadeEnabled: settingsData.crossfadeEnabled ?? false,
      crossfadeDuration: settingsData.crossfadeDuration ?? 5,
      gaplessEnabled: settingsData.gaplessEnabled ?? true,
    };
  } catch {
    return {};
  }
}

const persisted = loadPersistedState();

export const usePlayerStore = create<PlaybackState>((set, get) => ({
  queue: persisted.queue ?? [],
  currentIndex: persisted.currentIndex ?? -1,
  currentSong: persisted.currentSong ?? null,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  radioMode: null,
  radioPlaying: false,
  repeatMode: persisted.repeatMode ?? 'off',
  shuffleEnabled: persisted.shuffleEnabled ?? false,
  shuffleOrder: [],
  playbackSpeed: persisted.playbackSpeed ?? 1.0,
  crossfadeEnabled: persisted.crossfadeEnabled ?? false,
  crossfadeDuration: persisted.crossfadeDuration ?? 5,
  gaplessEnabled: persisted.gaplessEnabled ?? true,
  autoplayBaseLength: persisted.autoplayBaseLength ?? null,
  autoplaySeedSongId: persisted.autoplaySeedSongId ?? null,
  autoplayStatus: persisted.autoplayStatus ?? 'idle',
  autoplayRequestKey: null,

  playSongs: (songs, startIndex = 0, options) => {
    // Stop radio if playing
    if (get().radioMode) {
      getPlaybackManager().stopRadio();
    }
    const seedSong = songs[startIndex] ?? null;
    const autoplayEnabled = useUIStore.getState().autoplayQueueEnabled;
    const shouldPrepareAutoplay = (
      !options?.disableAutoplay
      && autoplayEnabled
      && navigator.onLine
      && songs.length > 0
      && seedSong !== null
    );
    const autoplayRequestKey = shouldPrepareAutoplay
      ? `${seedSong.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`
      : null;
    const state: Partial<PlaybackState> = {
      queue: songs,
      currentIndex: startIndex,
      currentSong: seedSong,
      isPlaying: true,
      radioMode: null,
      radioPlaying: false,
      positionMs: 0,
      ...(shouldPrepareAutoplay
        ? {
            autoplayBaseLength: songs.length,
            autoplaySeedSongId: seedSong.id,
            autoplayStatus: 'loading' as const,
            autoplayRequestKey,
          }
        : DEFAULT_AUTOPLAY_STATE),
    };
    if (get().shuffleEnabled) {
      state.shuffleOrder = shuffleArray(songs.length, startIndex);
    }
    set(state);
    persistQueue(get());

    if (!shouldPrepareAutoplay || !autoplayRequestKey || !seedSong) return;

    void prepareAutoplayTail({
      seedSong,
      explicitQueue: songs,
      activeFolderId: useMusicFolderStore.getState().activeFolderId ?? undefined,
      isStale: () => get().autoplayRequestKey !== autoplayRequestKey,
    }).then((result) => {
      const currentState = get();
      if (currentState.autoplayRequestKey !== autoplayRequestKey) return;
      if (result.status === 'stale') return;

      if (result.status === 'empty') {
        set({
          autoplayStatus: 'empty',
          autoplayRequestKey: null,
        });
        persistQueue(get());
        return;
      }

      if ((currentState.autoplayBaseLength ?? 0) < currentState.queue.length) {
        return;
      }

      const appendedQueue = [...currentState.queue, ...result.songs];
      const appendedShuffleOrder = currentState.shuffleEnabled
        ? [
            ...currentState.shuffleOrder,
            ...result.songs.map((_, index) => currentState.queue.length + index),
          ]
        : [];

      set({
        queue: appendedQueue,
        shuffleOrder: appendedShuffleOrder,
        autoplayStatus: result.status,
        autoplayRequestKey: null,
      });
      persistQueue(get());
    }).catch(() => {
      if (get().autoplayRequestKey !== autoplayRequestKey) return;
      set({
        autoplayStatus: 'empty',
        autoplayRequestKey: null,
      });
      persistQueue(get());
    });
  },

  playNext: (song) => {
    const { queue, currentIndex, shuffleEnabled, shuffleOrder } = get();
    const insertAt = currentIndex + 1;
    const newQueue = [...queue.slice(0, insertAt), song, ...queue.slice(insertAt)];
    // Update shuffle order to include the new index
    const newShuffleOrder = shuffleEnabled
      ? [...shuffleOrder.map((i) => (i >= insertAt ? i + 1 : i)), insertAt]
      : [];
    set({ queue: newQueue, shuffleOrder: newShuffleOrder, ...DEFAULT_AUTOPLAY_STATE });
    persistQueue(get());
  },

  addToQueue: (song) => {
    const { queue, shuffleEnabled, shuffleOrder } = get();
    const newQueue = [...queue, song];
    const newIndex = newQueue.length - 1;
    const newShuffleOrder = shuffleEnabled ? [...shuffleOrder, newIndex] : [];
    set({ queue: newQueue, shuffleOrder: newShuffleOrder, ...DEFAULT_AUTOPLAY_STATE });
    persistQueue(get());
  },

  removeFromQueue: (index) => {
    const { queue, currentIndex, shuffleEnabled, shuffleOrder } = get();
    if (index < 0 || index >= queue.length) return;

    const newQueue = queue.filter((_, i) => i !== index);
    let newIndex = currentIndex;
    if (index < currentIndex) {
      newIndex = currentIndex - 1;
    } else if (index === currentIndex) {
      newIndex = Math.min(currentIndex, newQueue.length - 1);
    }

    // Update shuffle order: remove the index and adjust remaining
    const newShuffleOrder = shuffleEnabled
      ? shuffleOrder.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i))
      : [];

    set({
      queue: newQueue,
      currentIndex: newIndex,
      currentSong: newIndex >= 0 && newIndex < newQueue.length ? newQueue[newIndex] : null,
      isPlaying: newQueue.length > 0 ? get().isPlaying : false,
      shuffleOrder: newShuffleOrder,
      ...DEFAULT_AUTOPLAY_STATE,
    });
    persistQueue(get());
  },

  clearQueue: () => {
    set({
      queue: [],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      positionMs: 0,
      durationMs: 0,
      shuffleOrder: [],
      ...DEFAULT_AUTOPLAY_STATE,
    });
    persistQueue(get());
  },

  skipToIndex: (index) => {
    const { queue } = get();
    if (index < 0 || index >= queue.length) return;
    set({
      currentIndex: index,
      currentSong: queue[index],
      isPlaying: true,
      positionMs: 0,
    });
    persistQueue(get());
  },

  next: () => {
    const { queue, currentIndex, shuffleEnabled, shuffleOrder, repeatMode } = get();
    if (queue.length === 0) return;

    // Repeat-one only applies to auto-advance (track ended), not manual skip
    let nextIndex: number;
    if (shuffleEnabled && shuffleOrder.length > 0) {
      const shufflePos = shuffleOrder.indexOf(currentIndex);
      const nextShufflePos = shufflePos + 1;
      if (nextShufflePos >= shuffleOrder.length) {
        if (repeatMode === 'all') {
          nextIndex = shuffleOrder[0];
        } else {
          set({ isPlaying: false });
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
          set({ isPlaying: false });
          return;
        }
      }
    }

    set({
      currentIndex: nextIndex,
      currentSong: queue[nextIndex],
      isPlaying: true,
      positionMs: 0,
    });
    persistQueue(get());
  },

  previous: () => {
    const { queue, currentIndex, shuffleEnabled, shuffleOrder, repeatMode, positionMs } = get();
    if (queue.length === 0) return;

    // If more than 3 seconds in, restart current song
    if (positionMs > 3000) {
      get().seek(0);
      return;
    }

    let prevIndex: number;
    if (shuffleEnabled && shuffleOrder.length > 0) {
      const shufflePos = shuffleOrder.indexOf(currentIndex);
      const prevShufflePos = shufflePos - 1;
      if (prevShufflePos < 0) {
        if (repeatMode === 'all') {
          prevIndex = shuffleOrder[shuffleOrder.length - 1];
        } else {
          set({ positionMs: 0 });
          return;
        }
      } else {
        prevIndex = shuffleOrder[prevShufflePos];
      }
    } else {
      prevIndex = currentIndex - 1;
      if (prevIndex < 0) {
        if (repeatMode === 'all') {
          prevIndex = queue.length - 1;
        } else {
          set({ positionMs: 0 });
          return;
        }
      }
    }

    set({
      currentIndex: prevIndex,
      currentSong: queue[prevIndex],
      isPlaying: true,
      positionMs: 0,
    });
    persistQueue(get());
  },

  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setPlaying: (playing) => set({ isPlaying: playing }),
  setPosition: (ms) => set({ positionMs: ms }),
  setDuration: (ms) => set({ durationMs: ms }),
  seek: (ms) => {
    set({ positionMs: ms });
    getPlaybackManager().seek(ms);
  },

  toggleShuffle: () => {
    const { shuffleEnabled, queue, currentIndex } = get();
    const newShuffle = !shuffleEnabled;
    const shuffleOrder = newShuffle ? shuffleArray(queue.length, currentIndex) : [];
    set({ shuffleEnabled: newShuffle, shuffleOrder });
    persistSettings(get());
  },

  cycleRepeat: () => {
    const modes: Array<'off' | 'all' | 'one'> = ['off', 'all', 'one'];
    const current = modes.indexOf(get().repeatMode);
    const next = modes[(current + 1) % modes.length];
    set({ repeatMode: next });
    persistSettings(get());
  },

  cycleSpeed: () => {
    const current = get().playbackSpeed;
    const idx = SPEED_OPTIONS.indexOf(current);
    const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    set({ playbackSpeed: next });
    persistSettings(get());
  },

  setSpeed: (speed) => {
    set({ playbackSpeed: speed });
    persistSettings(get());
  },

  setCrossfade: (enabled) => {
    set({ crossfadeEnabled: enabled });
    persistSettings(get());
  },

  setCrossfadeDuration: (seconds) => {
    set({ crossfadeDuration: seconds });
    persistSettings(get());
  },

  setGapless: (enabled) => {
    set({ gaplessEnabled: enabled });
    persistSettings(get());
  },

  toggleStarCurrent: async () => {
    if (starBusy) return;
    starBusy = true;
    const { currentSong, queue, currentIndex } = get();
    if (!currentSong) { starBusy = false; return; }
    if (!navigator.onLine) { starBusy = false; return; }

    const starred = !currentSong.starred;

    // Optimistic update
    const updatedSong = { ...currentSong, starred: starred ? new Date().toISOString() : undefined };
    const updatedQueue = [...queue];
    if (currentIndex >= 0 && currentIndex < updatedQueue.length) {
      updatedQueue[currentIndex] = { ...updatedQueue[currentIndex], starred: updatedSong.starred };
    }
    set({ currentSong: updatedSong, queue: updatedQueue });

    try {
      const client = getSubsonicClient();
      if (starred) {
        await client.star(currentSong.id);
      } else {
        await client.unstar(currentSong.id);
      }
    } catch {
      // Revert on failure
      set({ currentSong, queue });
    } finally {
      starBusy = false;
    }
  },

  reorderQueue: (from, to) => {
    const { queue, currentIndex, shuffleOrder, shuffleEnabled } = get();
    if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to) return;

    const newQueue = [...queue];
    const [moved] = newQueue.splice(from, 1);
    newQueue.splice(to, 0, moved);

    // Track where the currently playing song ends up
    let newCurrentIndex = currentIndex;
    if (from === currentIndex) {
      newCurrentIndex = to;
    } else {
      if (from < currentIndex && to >= currentIndex) newCurrentIndex--;
      else if (from > currentIndex && to <= currentIndex) newCurrentIndex++;
    }

    // Update shuffle order indices
    const newShuffleOrder = shuffleEnabled
      ? shuffleOrder.map((i) => {
          if (i === from) return to;
          if (from < to) {
            if (i > from && i <= to) return i - 1;
          } else {
            if (i >= to && i < from) return i + 1;
          }
          return i;
        })
      : [];

    set({
      queue: newQueue,
      currentIndex: newCurrentIndex,
      currentSong: newQueue[newCurrentIndex] ?? null,
      shuffleOrder: newShuffleOrder,
      ...DEFAULT_AUTOPLAY_STATE,
    });
    persistQueue(get());
  },

  playRadio: (station) => {
    set({
      radioMode: station,
      radioPlaying: true,
      isPlaying: false,
      ...DEFAULT_AUTOPLAY_STATE,
    });
  },

  stopRadio: () => {
    // Stop radio and return to paused state showing last song
    set({ radioMode: null, radioPlaying: false, isPlaying: false });
  },
}));
