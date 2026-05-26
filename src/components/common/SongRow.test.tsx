import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SongRow from './SongRow';
import { useAuthStore } from '../../stores/authStore';
import { useDownloadStore } from '../../stores/downloadStore';
import { usePlayerStore } from '../../stores/playerStore';

const queueSongsMock = vi.fn();
const removeFromCacheMock = vi.fn(async () => {});

const onlineStatusMocks = vi.hoisted(() => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('../../audio/DownloadManager', () => ({
  getDownloadManager: () => ({
    queueSongs: queueSongsMock,
  }),
}));

vi.mock('../../hooks/useOnlineStatus', () => onlineStatusMocks);

describe('SongRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useAuthStore.setState({
      servers: [{
        id: 'server-1',
        name: 'Primary',
        url: 'https://music.example.com',
        username: 'alice',
        password: 'secret',
      }],
      activeServerId: 'server-1',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    usePlayerStore.setState({
      currentSong: null,
      queue: [],
      currentIndex: -1,
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
      autoplayBaseLength: null,
      autoplaySeedSongId: null,
      autoplayStatus: 'idle',
      autoplayRequestKey: null,
    });

    useDownloadStore.setState({
      queue: [],
      cachedSongs: new Map(),
      totalCachedSize: 0,
      isDownloading: false,
      isLibrarySyncing: false,
      lastLibrarySyncAt: null,
      librarySyncError: null,
      removeFromCache: removeFromCacheMock,
    });

    onlineStatusMocks.useOnlineStatus.mockReturnValue(true);
  });

  const song = {
    id: 'song-1',
    title: 'Song 1',
    artist: 'Artist 1',
    artistId: 'artist-1',
    album: 'Album 1',
    albumId: 'album-1',
    duration: 180,
  };

  function renderRow() {
    render(
      <MemoryRouter>
        <SongRow song={song} />
      </MemoryRouter>,
    );
  }

  it('shows Download in the menu when song is not downloaded', () => {
    renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));

    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('shows disabled Download offline', () => {
    onlineStatusMocks.useOnlineStatus.mockReturnValue(false);

    renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));

    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
  });

  it('shows disabled Downloading state when song is queued', () => {
    useDownloadStore.setState({
      queue: [{
        cacheId: 'server-1:song-1',
        serverId: 'server-1',
        serverName: 'Primary',
        serverUrl: 'https://music.example.com',
        username: 'alice',
        cacheKey: 'audio-1',
        downloadUrl: 'https://music.example.com/stream/song-1',
        song,
        progress: 0.5,
        requiredProgress: 0.27,
        status: 'downloading',
        phase: 'audio',
        optionalPhase: null,
      }],
    });

    renderRow();

    expect(screen.getByLabelText('Downloading')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));

    expect(screen.getByRole('button', { name: 'Downloading...' })).toBeDisabled();
  });

  it('shows Remove download and indicator when song is cached', () => {
    useDownloadStore.setState({
      cachedSongs: new Map([
        ['server-1:song-1', {
          cacheId: 'server-1:song-1',
          songId: 'song-1',
          serverId: 'server-1',
          serverName: 'Primary',
          serverUrl: 'https://music.example.com',
          username: 'alice',
          cacheKey: 'audio-1',
          title: 'Song 1',
          size: 123,
          cachedAt: Date.now(),
          requiredAssetsReady: true,
        }],
      ]),
    });

    renderRow();

    expect(screen.getByLabelText('Available offline')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove download' }));

    expect(removeFromCacheMock).toHaveBeenCalledWith('server-1:song-1');
  });

  it('queues download from the menu', () => {
    renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    expect(queueSongsMock).toHaveBeenCalledWith([song], 'album-1');
  });
});
