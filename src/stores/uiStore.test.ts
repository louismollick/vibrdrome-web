import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIStore } from './uiStore';

beforeEach(() => {
  localStorage.clear();
  useUIStore.setState({
    theme: 'system',
    accentColor: '#8b5cf6',
    reduceMotion: false,
    keyboardShortcutsEnabled: true,
    streamQuality: 0,
    lastfmApiKey: '',
    epilepsyWarningDismissed: false,
    commandPaletteOpen: false,
    popOutPlayerOpen: false,
    queueSyncEnabled: false,
    autoplayQueueEnabled: true,
    libraryAutoSyncEnabled: false,
    lyricsInteractionMode: 'seek',
  });
});

describe('uiStore', () => {
  describe('theme', () => {
    it('defaults to system', () => {
      expect(useUIStore.getState().theme).toBe('system');
    });

    it('sets theme', () => {
      useUIStore.getState().setTheme('dark');
      expect(useUIStore.getState().theme).toBe('dark');
    });

    it('accepts all valid themes', () => {
      const themes = ['system', 'dark', 'light', 'apple', 'apple-dark', 'retro', 'terminal', 'midnight', 'sunset'] as const;
      for (const t of themes) {
        useUIStore.getState().setTheme(t);
        expect(useUIStore.getState().theme).toBe(t);
      }
    });
  });

  describe('accentColor', () => {
    it('defaults to purple', () => {
      expect(useUIStore.getState().accentColor).toBe('#8b5cf6');
    });

    it('sets accent color', () => {
      useUIStore.getState().setAccentColor('#ff0000');
      expect(useUIStore.getState().accentColor).toBe('#ff0000');
    });
  });

  describe('reduceMotion', () => {
    it('defaults to false', () => {
      expect(useUIStore.getState().reduceMotion).toBe(false);
    });

    it('toggles', () => {
      useUIStore.getState().setReduceMotion(true);
      expect(useUIStore.getState().reduceMotion).toBe(true);
    });
  });

  describe('keyboardShortcuts', () => {
    it('defaults to enabled', () => {
      expect(useUIStore.getState().keyboardShortcutsEnabled).toBe(true);
    });

    it('can be disabled', () => {
      useUIStore.getState().setKeyboardShortcutsEnabled(false);
      expect(useUIStore.getState().keyboardShortcutsEnabled).toBe(false);
    });
  });

  describe('streamQuality', () => {
    it('defaults to 0 (original)', () => {
      expect(useUIStore.getState().streamQuality).toBe(0);
    });

    it('sets quality', () => {
      useUIStore.getState().setStreamQuality(320);
      expect(useUIStore.getState().streamQuality).toBe(320);
    });
  });

  describe('commandPalette', () => {
    it('opens and closes', () => {
      expect(useUIStore.getState().commandPaletteOpen).toBe(false);
      useUIStore.getState().openCommandPalette();
      expect(useUIStore.getState().commandPaletteOpen).toBe(true);
      useUIStore.getState().closeCommandPalette();
      expect(useUIStore.getState().commandPaletteOpen).toBe(false);
    });
  });

  describe('popOutPlayer', () => {
    it('opens and closes', () => {
      expect(useUIStore.getState().popOutPlayerOpen).toBe(false);
      useUIStore.getState().setPopOutPlayerOpen(true);
      expect(useUIStore.getState().popOutPlayerOpen).toBe(true);
      useUIStore.getState().setPopOutPlayerOpen(false);
      expect(useUIStore.getState().popOutPlayerOpen).toBe(false);
    });
  });

  describe('lastfmApiKey', () => {
    it('defaults to empty', () => {
      expect(useUIStore.getState().lastfmApiKey).toBe('');
    });

    it('sets key', () => {
      useUIStore.getState().setLastfmApiKey('test123');
      expect(useUIStore.getState().lastfmApiKey).toBe('test123');
    });
  });

  describe('epilepsyWarning', () => {
    it('defaults to not dismissed', () => {
      expect(useUIStore.getState().epilepsyWarningDismissed).toBe(false);
    });

    it('can be dismissed', () => {
      useUIStore.getState().setEpilepsyWarningDismissed(true);
      expect(useUIStore.getState().epilepsyWarningDismissed).toBe(true);
    });
  });

  describe('libraryAutoSync', () => {
    it('defaults to disabled', () => {
      expect(useUIStore.getState().libraryAutoSyncEnabled).toBe(false);
    });

    it('can be enabled', () => {
      useUIStore.getState().setLibraryAutoSyncEnabled(true);
      expect(useUIStore.getState().libraryAutoSyncEnabled).toBe(true);
    });
  });

  describe('autoplayQueue', () => {
    it('defaults to enabled', () => {
      expect(useUIStore.getState().autoplayQueueEnabled).toBe(true);
    });

    it('persists toggle state', async () => {
      useUIStore.getState().setAutoplayQueueEnabled(false);

      expect(useUIStore.getState().autoplayQueueEnabled).toBe(false);
      expect(localStorage.getItem('vibrdrome_autoplay_queue')).toBe('false');

      vi.resetModules();
      const { useUIStore: reloadedStore } = await import('./uiStore');
      expect(reloadedStore.getState().autoplayQueueEnabled).toBe(false);
    });
  });

  describe('lyricsInteractionMode', () => {
    it('defaults to seek on fresh storage', async () => {
      localStorage.clear();
      vi.resetModules();
      const { useUIStore: reloadedStore } = await import('./uiStore');

      expect(reloadedStore.getState().lyricsInteractionMode).toBe('seek');
    });

    it('persists the selected mode to localStorage', () => {
      useUIStore.getState().setLyricsInteractionMode('dictionary');

      expect(useUIStore.getState().lyricsInteractionMode).toBe('dictionary');
      expect(localStorage.getItem('vibrdrome_lyrics_interaction_mode')).toBe('dictionary');
    });

    it('restores dictionary mode after reloading the store', async () => {
      localStorage.setItem('vibrdrome_lyrics_interaction_mode', 'dictionary');
      vi.resetModules();
      const { useUIStore: reloadedStore } = await import('./uiStore');

      expect(reloadedStore.getState().lyricsInteractionMode).toBe('dictionary');
    });
  });
});
