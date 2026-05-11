import { useEffect, useRef } from 'react';
import { getPlaybackManager } from './PlaybackManager';
import { usePlayerStore } from '../stores/playerStore';
import { useUIStore } from '../stores/uiStore';
import { useEQStore } from '../stores/eqStore';
import { getSubsonicClient } from '../api/SubsonicClient';
import { syncPosition, loadServerQueue } from '../utils/queueSync';

// The PlaybackManager is a singleton — grab it once at module level
const manager = getPlaybackManager();

function persistLocalPosition(positionMs: number): void {
  try {
    const raw = localStorage.getItem('vibrdrome_queue');
    if (raw) {
      const data = JSON.parse(raw);
      data.positionMs = positionMs;
      localStorage.setItem('vibrdrome_queue', JSON.stringify(data));
    }
  } catch { /* ignore */ }
}

export function usePlayback() {
  const initializedRef = useRef(false);
  const playbackSpeed = usePlayerStore((s) => s.playbackSpeed);
  const eqBands = useEQStore((s) => s.bands);
  const eqEnabled = useEQStore((s) => s.enabled);

  // Warmup audio context on every user interaction
  useEffect(() => {
    const warmupHandler = () => {
      if (!initializedRef.current) {
        initializedRef.current = true;
      }
      manager.warmup();
    };

    const keyHandler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!useUIStore.getState().keyboardShortcutsEnabled) return;

      const store = usePlayerStore.getState();

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (store.radioMode) {
            // Toggle radio
            const pm = getPlaybackManager();
            if (store.radioPlaying) pm.pauseRadio();
            else pm.resumeRadio();
            usePlayerStore.setState({ radioPlaying: !store.radioPlaying });
          } else if (store.currentSong) {
            store.togglePlay();
          }
          break;
        case 'ArrowRight':
          if (!store.radioMode) {
            if (e.shiftKey) {
              manager.seek(Math.min((manager.getPosition() + 10) * 1000, store.durationMs));
            } else {
              store.next();
            }
          }
          break;
        case 'ArrowLeft':
          if (!store.radioMode) {
            if (e.shiftKey) {
              manager.seek(Math.max((manager.getPosition() - 10) * 1000, 0));
            } else {
              store.previous();
            }
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          manager.setVolume(Math.min(1, manager.getVolume() + 0.05));
          break;
        case 'ArrowDown':
          e.preventDefault();
          manager.setVolume(Math.max(0, manager.getVolume() - 0.05));
          break;
        case 'm':
        case 'M':
          manager.toggleMute();
          break;
        case 's':
        case 'S':
          if (!store.radioMode) store.toggleShuffle();
          break;
        case 'r':
        case 'R':
          if (!store.radioMode) store.cycleRepeat();
          break;
        case '?':
          useUIStore.getState().setShortcutsOverlayOpen(true);
          break;
      }
    };

    document.addEventListener('click', warmupHandler);
    document.addEventListener('keydown', warmupHandler);
    document.addEventListener('keydown', keyHandler);
    document.addEventListener('touchstart', warmupHandler);

    return () => {
      document.removeEventListener('click', warmupHandler);
      document.removeEventListener('keydown', warmupHandler);
      document.removeEventListener('keydown', keyHandler);
      document.removeEventListener('touchstart', warmupHandler);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = usePlayerStore.subscribe((state, prevState) => {
      const songChanged = state.currentSong?.id !== prevState.currentSong?.id;
      const playingChanged = state.isPlaying !== prevState.isPlaying;
      let handledBySongChange = false;

      if (songChanged) {
        const currentSong = state.currentSong;
        if (!currentSong || !initializedRef.current || state.radioMode) return;

        handledBySongChange = true;
        const restoredPosition = state.positionMs;
        manager.play(currentSong).then(() => {
          // Seek to restored position after reload (e.g., page refresh mid-song)
          const latestState = usePlayerStore.getState();
          if (latestState.currentSong?.id === currentSong.id && restoredPosition > 0) {
            manager.seek(restoredPosition);
          }
        });

        // Desktop notification
        if (useUIStore.getState().notificationsEnabled && Notification.permission === 'granted') {
          const icon = currentSong.coverArt
            ? getSubsonicClient().getCoverArt(currentSong.coverArt, 256)
            : undefined;
          new Notification(currentSong.title, {
            body: `${currentSong.artist ?? 'Unknown Artist'} — ${currentSong.album ?? 'Unknown Album'}`,
            icon,
            silent: true,
            tag: 'vibrdrome-now-playing',
          });
        }
      }

      if (!playingChanged || !state.currentSong || state.radioMode || handledBySongChange) return;

      if (manager.consumePendingStorePlaybackSync(state.isPlaying)) {
        if (!state.isPlaying) {
          syncPosition();
          persistLocalPosition(state.positionMs);
        }
        return;
      }

      if (state.isPlaying) {
        if (!manager.hasSource()) {
          manager.play(state.currentSong);
        } else {
          manager.resume();
        }
      } else {
        manager.pause();
        syncPosition();
        persistLocalPosition(state.positionMs);
      }
    });

    return unsubscribe;
  }, []);

  // Watch for playback speed changes
  useEffect(() => {
    manager.setPlaybackRate(playbackSpeed);
  }, [playbackSpeed]);

  // Watch for EQ changes
  useEffect(() => {
    manager.updateEQ(eqBands, eqEnabled);
  }, [eqBands, eqEnabled]);

  // Server queue sync: periodic position save + startup load + beforeunload
  useEffect(() => {
    // Load queue from server if local queue is empty
    loadServerQueue();

    // Save position every 30s while playing
    const interval = setInterval(() => {
      const { currentSong: song, isPlaying: playing } = usePlayerStore.getState();
      if (song && playing) syncPosition();
    }, 30_000);

    // Save on page unload (server + local)
    const handleUnload = () => {
      syncPosition();
      try {
        const state = usePlayerStore.getState();
        const raw = localStorage.getItem('vibrdrome_queue');
        if (raw) {
          const data = JSON.parse(raw);
          data.positionMs = state.positionMs;
          localStorage.setItem('vibrdrome_queue', JSON.stringify(data));
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, []);

  return manager;
}
