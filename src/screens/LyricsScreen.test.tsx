import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LyricsScreen from './LyricsScreen';
import { useAuthStore } from '../stores/authStore';
import { usePlayerStore } from '../stores/playerStore';
import { useUIStore } from '../stores/uiStore';
import { resetLyricsTokenizationManagerForTests } from '../utils/lyricsTokenizationManager';

type TestToken = {
  text: string;
  reading: string;
  term: string;
  selectable: boolean;
  kind: 'word' | 'other';
};

const seekMock = vi.fn();
const refreshLyricsMock = vi.fn(async () => {});

const lyricsHookMocks = vi.hoisted(() => ({
  useCurrentSongLyrics: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  getInstalledDictionaries: vi.fn(),
  tokenizeText: vi.fn(),
  lookupTerm: vi.fn(),
  buildEnabledDictionaryMap: vi.fn(),
  createTermEntryRenderer: vi.fn(),
}));

const preferenceMocks = vi.hoisted(() => ({
  YOMITAN_DICTIONARY_STATE_CHANGED_EVENT: 'vibrdrome:yomitan-dictionary-state-changed',
  loadDictionaryPreferences: vi.fn(),
  normalizeDictionaryPreferences: vi.fn(),
  saveDictionaryPreferences: vi.fn(),
}));

const offlineLyricsStoreMocks = vi.hoisted(() => ({
  getOfflineTokenizedLyrics: vi.fn(),
  putOfflineTokenizedLyrics: vi.fn(),
}));

let persistedTokenizedLyrics: Record<string, TestToken[]> | null = null;

vi.mock('../hooks/useCurrentSongLyrics', () => lyricsHookMocks);
vi.mock('../audio/PlaybackManager', () => ({
  getPlaybackManager: () => ({ seek: seekMock }),
}));
vi.mock('../utils/yomitan/core', () => coreMocks);
vi.mock('../utils/yomitan/preferences', () => preferenceMocks);
vi.mock('../utils/offlineLyricsStore', () => offlineLyricsStoreMocks);

describe('LyricsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetLyricsTokenizationManagerForTests();
    persistedTokenizedLyrics = null;

    useAuthStore.setState({
      servers: [],
      activeServerId: 'server-1',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    usePlayerStore.setState({
      currentSong: {
        id: 'song-1',
        title: 'Song 1',
        artist: 'Artist 1',
      },
      positionMs: 500,
      isPlaying: true,
    });

    useUIStore.setState({
      lyricsInteractionMode: 'seek',
    });

    lyricsHookMocks.useCurrentSongLyrics.mockReturnValue({
      status: 'ready',
      lyrics: {
        lang: 'ja',
        synced: true,
        line: [
          { start: 0, value: '日本語猫' },
          { start: 1000, value: '次の行' },
        ],
      },
      refreshLyrics: refreshLyricsMock,
      isRefreshing: false,
    });

    coreMocks.getInstalledDictionaries.mockResolvedValue([
      { title: 'JMdict', importDate: Date.now(), revision: '1', version: 3 },
    ]);
    preferenceMocks.loadDictionaryPreferences.mockReturnValue([
      { title: 'JMdict', enabled: true },
    ]);
    preferenceMocks.normalizeDictionaryPreferences.mockImplementation((_installed, existing) => existing);
    offlineLyricsStoreMocks.getOfflineTokenizedLyrics.mockImplementation(async () => persistedTokenizedLyrics);
    offlineLyricsStoreMocks.putOfflineTokenizedLyrics.mockImplementation(async (_serverId, _songId, _fingerprint, lines) => {
      persistedTokenizedLyrics = {
        ...(persistedTokenizedLyrics ?? {}),
        ...lines,
      };
    });
    coreMocks.buildEnabledDictionaryMap.mockReturnValue(
      new Map([['JMdict', { index: 0, priority: 0 }]]),
    );
    coreMocks.tokenizeText.mockImplementation(async (line: string) => {
      if (line === '日本語猫') {
        return [
          { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
          { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
        ];
      }

      return [
        { text: '次', reading: 'つぎ', term: '次', selectable: true, kind: 'word' },
        { text: 'の行', reading: '', term: 'の行', selectable: false, kind: 'other' },
      ];
    });
    coreMocks.lookupTerm.mockImplementation(async (term: string) => ({
      entries: [{ id: term }],
      originalTextLength: term.length,
    }));
    coreMocks.createTermEntryRenderer.mockReturnValue({
      prepareHost: vi.fn(),
      updateHost: vi.fn(),
      destroy: vi.fn(),
      renderTermEntries: vi.fn((entries: Array<{ id: string }>) =>
        entries.map((entry, index) => {
          const entryNode = document.createElement('div');
          entryNode.textContent = `entry-${entry.id}`;
          return { index, entry, entryNode };
        })),
    });
  });

  function renderScreen() {
    return render(
      <MemoryRouter>
        <LyricsScreen />
      </MemoryRouter>,
    );
  }

  it('defaults to seek mode on fresh storage', () => {
    renderScreen();

    expect(screen.getByRole('button', { name: '日本語猫' })).toBeInTheDocument();
  });

  it('keeps dictionary mode selected across reopen and song changes', async () => {
    useUIStore.getState().setLyricsInteractionMode('dictionary');

    const view = renderScreen();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '日本語' })).toBeInTheDocument();
    });

    view.unmount();

    usePlayerStore.setState({
      currentSong: {
        id: 'song-2',
        title: 'Song 2',
        artist: 'Artist 2',
      },
    });

    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '日本語' })).toBeInTheDocument();
    });
  });

  it('retains click-to-seek behavior in seek mode', async () => {
    renderScreen();

    await fireEvent.click(screen.getByRole('button', { name: '日本語猫' }));

    expect(seekMock).toHaveBeenCalledWith(0);
  });

  it('renders clickable underlined tokens and removes line seeking in dictionary mode', async () => {
    useUIStore.getState().setLyricsInteractionMode('dictionary');

    renderScreen();

    const tokenButton = await screen.findByRole('button', { name: '日本語' });

    expect(tokenButton.className).toContain('underline');
    expect(tokenButton.className).toContain('[text-decoration-thickness:auto]');
    expect(screen.queryByRole('button', { name: '日本語猫' })).toBeNull();

    await fireEvent.click(tokenButton);

    expect(seekMock).not.toHaveBeenCalled();
  });

  it('renders tokenized results across multiple lines after preparation completes', async () => {
    useUIStore.getState().setLyricsInteractionMode('dictionary');

    renderScreen();

    await waitFor(() => {
      expect(screen.queryByText(/Preparing dictionary mode/i)).toBeNull();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '日本語' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '猫' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '次' })).toBeInTheDocument();
    });
  });

  it('renders Latin-script lyric segments without making them dictionary tokens', async () => {
    useUIStore.getState().setLyricsInteractionMode('dictionary');
    lyricsHookMocks.useCurrentSongLyrics.mockReturnValue({
      status: 'ready',
      lyrics: {
        lang: 'ja',
        synced: false,
        line: [
          { start: 0, value: 'I love 日本語' },
        ],
      },
      refreshLyrics: refreshLyricsMock,
      isRefreshing: false,
    });
    coreMocks.tokenizeText.mockResolvedValue([
      { text: 'I', reading: '', term: 'I', selectable: false, kind: 'other' },
      { text: ' ', reading: '', term: ' ', selectable: false, kind: 'other' },
      { text: 'love', reading: '', term: 'love', selectable: false, kind: 'other' },
      { text: ' ', reading: '', term: ' ', selectable: false, kind: 'other' },
      { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
    ]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '日本語' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'I' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'love' })).toBeNull();
    expect(screen.getByText('I')).toBeInTheDocument();
    expect(screen.getByText('love')).toBeInTheDocument();
  });

  it('shows guidance instead of broken UI when no dictionaries are installed', async () => {
    useUIStore.getState().setLyricsInteractionMode('dictionary');
    coreMocks.getInstalledDictionaries.mockResolvedValue([]);
    preferenceMocks.loadDictionaryPreferences.mockReturnValue([]);
    preferenceMocks.normalizeDictionaryPreferences.mockReturnValue([]);
    coreMocks.buildEnabledDictionaryMap.mockReturnValue(new Map());

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText(/No Yomitan dictionaries are installed/i)).toBeInTheDocument();
    });
  });

  it('calls refresh from the lyrics header action', async () => {
    renderScreen();

    await fireEvent.click(screen.getByRole('button', { name: 'Refresh lyrics' }));

    expect(refreshLyricsMock).toHaveBeenCalled();
  });

  it('disables refresh while offline', () => {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: false,
    });

    renderScreen();

    expect(screen.getByRole('button', { name: 'Refresh lyrics' })).toBeDisabled();
  });
});
