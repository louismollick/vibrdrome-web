import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LyricsScreen from './LyricsScreen';
import { useAuthStore } from '../stores/authStore';
import { usePlayerStore } from '../stores/playerStore';
import { useUIStore } from '../stores/uiStore';

type TestToken = {
  text: string;
  reading: string;
  term: string;
  selectable: boolean;
  kind: 'word' | 'other';
};

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

const seekMock = vi.fn();

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

vi.mock('../hooks/useCurrentSongLyrics', () => lyricsHookMocks);
vi.mock('../audio/PlaybackManager', () => ({
  getPlaybackManager: () => ({ seek: seekMock }),
}));
vi.mock('../utils/yomitan/core', () => coreMocks);
vi.mock('../utils/yomitan/preferences', () => preferenceMocks);

describe('LyricsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

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
    });

    coreMocks.getInstalledDictionaries.mockResolvedValue([
      { title: 'JMdict', importDate: Date.now(), revision: '1', version: 3 },
    ]);
    preferenceMocks.loadDictionaryPreferences.mockReturnValue([
      { title: 'JMdict', enabled: true },
    ]);
    preferenceMocks.normalizeDictionaryPreferences.mockImplementation((_installed, existing) => existing);
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

    expect(tokenButton.className).toContain('after:bg-accent/70');
    expect(screen.queryByRole('button', { name: '日本語猫' })).toBeNull();

    await fireEvent.click(tokenButton);

    expect(seekMock).not.toHaveBeenCalled();
  });

  it('shows dictionary preparation progress while tokens are still loading', async () => {
    useUIStore.getState().setLyricsInteractionMode('dictionary');

    const firstLine = createDeferred<TestToken[]>();
    const secondLine = createDeferred<TestToken[]>();

    coreMocks.tokenizeText.mockImplementationOnce(
      () => firstLine.promise,
    );
    coreMocks.tokenizeText.mockImplementationOnce(
      () => secondLine.promise,
    );

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText(/Preparing dictionary mode/i)).toBeInTheDocument();
      expect(screen.getByText(/Tokenized 0 of 2 lines/i)).toBeInTheDocument();
    });

    firstLine.resolve([
      { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
    ]);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '日本語' })).toBeInTheDocument();
      expect(screen.getByText(/Tokenized 1 of 2 lines/i)).toBeInTheDocument();
    });

    secondLine.resolve([
      { text: '次', reading: 'つぎ', term: '次', selectable: true, kind: 'word' },
      { text: 'の行', reading: '', term: 'の行', selectable: false, kind: 'other' },
    ]);

    await waitFor(() => {
      expect(screen.queryByText(/Preparing dictionary mode/i)).toBeNull();
    });
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
});
