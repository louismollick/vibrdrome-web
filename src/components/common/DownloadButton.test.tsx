import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DownloadButton from './DownloadButton';
import { useAuthStore } from '../../stores/authStore';
import { useDownloadStore } from '../../stores/downloadStore';

const queueSongsMock = vi.fn();

const onlineStatusMocks = vi.hoisted(() => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('../../audio/DownloadManager', () => ({
  getDownloadManager: () => ({
    queueSongs: queueSongsMock,
  }),
}));

vi.mock('../../hooks/useOnlineStatus', () => onlineStatusMocks);

describe('DownloadButton', () => {
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

    useDownloadStore.setState({
      queue: [],
      cachedSongs: new Map(),
      totalCachedSize: 0,
      isDownloading: false,
      isLibrarySyncing: false,
      lastLibrarySyncAt: null,
      librarySyncError: null,
      removeSongsFromCache: vi.fn(async () => {}),
    });

    onlineStatusMocks.useOnlineStatus.mockReturnValue(true);
  });

  const songs = [
    { id: 'song-1', title: 'Song 1' },
    { id: 'song-2', title: 'Song 2' },
  ];

  it('queues uncached songs for download', () => {
    render(<DownloadButton songs={songs} albumId="album-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Download for offline' }));

    expect(queueSongsMock).toHaveBeenCalledWith(songs, 'album-1');
  });

  it('removes all downloads when every song is cached', () => {
    const removeSongsFromCache = vi.fn(async () => {});
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
        ['server-1:song-2', {
          cacheId: 'server-1:song-2',
          songId: 'song-2',
          serverId: 'server-1',
          serverName: 'Primary',
          serverUrl: 'https://music.example.com',
          username: 'alice',
          cacheKey: 'audio-2',
          title: 'Song 2',
          size: 123,
          cachedAt: Date.now(),
          requiredAssetsReady: true,
        }],
      ]),
      removeSongsFromCache,
    });

    render(<DownloadButton songs={songs} />);

    const button = screen.getByRole('button', { name: 'Remove download' });
    expect(button).toHaveAttribute('title', 'Remove download');

    fireEvent.click(button);

    expect(removeSongsFromCache).toHaveBeenCalledWith('server-1', ['song-1', 'song-2']);
    expect(queueSongsMock).not.toHaveBeenCalled();
  });

  it('queues only missing songs when collection is mixed', () => {
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
      queue: [{
        cacheId: 'server-1:song-3',
        serverId: 'server-1',
        serverName: 'Primary',
        serverUrl: 'https://music.example.com',
        username: 'alice',
        cacheKey: 'audio-3',
        downloadUrl: 'https://music.example.com/stream/song-3',
        song: { id: 'song-3', title: 'Song 3' },
        progress: 0.4,
        requiredProgress: 0.22,
        status: 'downloading',
        phase: 'audio',
        optionalPhase: null,
      }],
    });

    render(<DownloadButton songs={[...songs, { id: 'song-3', title: 'Song 3' }]} />);

    const button = screen.getByRole('button', { name: 'Downloading...' });
    expect(button).toHaveAttribute('title', 'Downloading...');

    fireEvent.click(button);

    expect(queueSongsMock).toHaveBeenCalledWith([{ id: 'song-2', title: 'Song 2' }], undefined);
  });

  it('disables download while offline when collection is not fully cached', () => {
    onlineStatusMocks.useOnlineStatus.mockReturnValue(false);

    render(<DownloadButton songs={songs} />);

    expect(screen.getByRole('button', { name: 'Download for offline' })).toBeDisabled();
    expect(queueSongsMock).not.toHaveBeenCalled();
  });
});
