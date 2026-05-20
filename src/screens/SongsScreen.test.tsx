import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SongsScreen from './SongsScreen';
import { useAuthStore } from '../stores/authStore';
import { useMusicFolderStore } from '../stores/musicFolderStore';
import { usePlayerStore } from '../stores/playerStore';
import { useUIStore } from '../stores/uiStore';

const subsonicMocks = vi.hoisted(() => ({
  getGenres: vi.fn(),
  getRandomSongs: vi.fn(),
}));

const navidromeMocks = vi.hoisted(() => ({
  setConfig: vi.fn(),
  login: vi.fn(),
  getSongsPage: vi.fn(),
  getTags: vi.fn(),
  getLastSongsPageTotalCount: vi.fn(),
  getAvailabilityStatus: vi.fn(),
  isAvailable: vi.fn(),
}));

const onlineStatusMock = vi.hoisted(() => ({
  useOnlineStatus: vi.fn(),
}));

const offlineLibraryMock = vi.hoisted(() => ({
  useOfflineLibrary: vi.fn(),
}));

vi.mock('../api/SubsonicClient', () => ({
  getSubsonicClient: () => subsonicMocks,
}));

vi.mock('../api/NavidromeClient', () => ({
  getNavidromeClient: () => navidromeMocks,
}));

vi.mock('../hooks/useOnlineStatus', () => onlineStatusMock);
vi.mock('../hooks/useOfflineLibrary', () => offlineLibraryMock);
vi.mock('../components/common', () => ({
  Header: ({ title }: { title: string }) => <div>{title}</div>,
  SongRow: ({ song, onPlay }: { song: { title: string }; onPlay?: () => void }) => (
    <button onClick={onPlay}>{song.title}</button>
  ),
  LoadingSpinner: () => <div>Loading...</div>,
  StateMessage: ({ title, body }: { title: string; body?: string }) => (
    <div>
      <div>{title}</div>
      {body ? <div>{body}</div> : null}
    </div>
  ),
}));
vi.mock('../components/common/BatchActionBar', () => ({
  default: () => null,
}));

describe('SongsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    class MockIntersectionObserver {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

    useAuthStore.setState({
      servers: [{
        id: 'server-1',
        name: 'Server',
        url: 'https://music.example.com',
        username: 'user',
        password: 'pass',
      }],
      activeServerId: 'server-1',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    useMusicFolderStore.setState({
      folders: [],
      activeFolderId: '12',
      loaded: true,
    });

    useUIStore.setState({
      navidromeTagFiltersEnabled: false,
    });

    usePlayerStore.setState({
      playSongs: vi.fn(),
    });

    onlineStatusMock.useOnlineStatus.mockReturnValue(true);
    offlineLibraryMock.useOfflineLibrary.mockReturnValue({
      songs: [],
      genres: [],
      hasOfflineContent: false,
    });

    subsonicMocks.getGenres.mockResolvedValue([]);
    subsonicMocks.getRandomSongs.mockResolvedValue([]);
    navidromeMocks.login.mockResolvedValue(undefined);
    navidromeMocks.getSongsPage.mockResolvedValue([]);
    navidromeMocks.getTags.mockResolvedValue([]);
    navidromeMocks.getLastSongsPageTotalCount.mockReturnValue(0);
  });

  function renderScreen() {
    return render(
      <MemoryRouter>
        <SongsScreen />
      </MemoryRouter>,
    );
  }

  it('uses Navidrome song + tag APIs instead of random songs when enabled', async () => {
    useUIStore.setState({ navidromeTagFiltersEnabled: true });
    navidromeMocks.getSongsPage.mockResolvedValueOnce([
      {
        id: 'nav-1',
        title: 'Native Song',
        artist: 'Artist',
        genre: 'Rock',
        year: 2024,
        tags: { language: ['en'] },
        lyrics: JSON.stringify([{ synced: true }]),
      },
    ]);
    navidromeMocks.getTags.mockResolvedValueOnce([
      { id: '1', tagName: 'language', tagValue: 'en' },
    ]);

    renderScreen();

    expect(await screen.findByText('Native Song')).toBeInTheDocument();
    expect(navidromeMocks.login).toHaveBeenCalled();
    expect(navidromeMocks.getSongsPage).toHaveBeenCalledWith({
      start: 0,
      end: 250,
      sort: 'path',
      order: 'ASC',
      libraryId: 12,
    });
    expect(navidromeMocks.getTags).toHaveBeenCalledWith({ libraryId: 12 });
    expect(subsonicMocks.getRandomSongs).not.toHaveBeenCalled();
  });

  it('falls back to standard songs and shows a notice when native auth fails', async () => {
    useUIStore.setState({ navidromeTagFiltersEnabled: true });
    navidromeMocks.login.mockRejectedValueOnce(new Error('bad auth'));
    subsonicMocks.getRandomSongs.mockResolvedValueOnce([
      { id: 'sub-1', title: 'Fallback Song', artist: 'Artist' },
    ]);

    renderScreen();

    expect(await screen.findByText('Fallback Song')).toBeInTheDocument();
    expect(screen.getByText('Navidrome tag filters unavailable for this server. Showing standard Songs view.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Lyrics state')).toBeNull();
  });

  it('combines lyrics-state and custom language tag filters in native mode', async () => {
    useUIStore.setState({ navidromeTagFiltersEnabled: true });
    navidromeMocks.getSongsPage.mockResolvedValueOnce([
      {
        id: 'nav-1',
        title: 'English Synced',
        artist: 'Artist',
        genre: 'Rock',
        year: 2024,
        tags: { language: ['en'] },
        lyrics: JSON.stringify([{ synced: true }]),
      },
      {
        id: 'nav-2',
        title: 'French Synced',
        artist: 'Artist',
        genre: 'Rock',
        year: 2024,
        tags: { language: ['fr'] },
        lyrics: JSON.stringify([{ synced: true }]),
      },
      {
        id: 'nav-3',
        title: 'English No Lyrics',
        artist: 'Artist',
        genre: 'Rock',
        year: 2024,
        tags: { language: ['en'] },
        lyrics: '',
      },
    ]);
    navidromeMocks.getTags.mockResolvedValueOnce([
      { id: '1', tagName: 'language', tagValue: 'en' },
      { id: '2', tagName: 'language', tagValue: 'fr' },
    ]);

    renderScreen();

    expect(await screen.findByText('English Synced')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Filters'));

    expect(screen.queryByLabelText('Tag name')).toBeNull();

    fireEvent.change(screen.getByLabelText('Lyrics state'), {
      target: { value: 'synced' },
    });
    fireEvent.click(screen.getByText('Add Tag Filter'));

    const tagNameSelect = screen.getByLabelText('Tag name') as HTMLSelectElement;
    expect(tagNameSelect.value).toBe('language');

    await waitFor(() => {
      expect(screen.getByText('English Synced')).toBeInTheDocument();
      expect(screen.queryByText('French Synced')).toBeNull();
      expect(screen.queryByText('English No Lyrics')).toBeNull();
    });
  });

  it('stays on the standard branch when the setting is disabled', async () => {
    subsonicMocks.getRandomSongs.mockResolvedValueOnce([
      { id: 'sub-1', title: 'Standard Song', artist: 'Artist' },
    ]);

    renderScreen();

    expect(await screen.findByText('Standard Song')).toBeInTheDocument();
    expect(subsonicMocks.getRandomSongs).toHaveBeenCalled();
    expect(navidromeMocks.login).not.toHaveBeenCalled();
  });
});
