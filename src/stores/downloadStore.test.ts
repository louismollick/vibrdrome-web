import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from './authStore';
import { useDownloadStore } from './downloadStore';

const dbMock = {
  put: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
  getAll: vi.fn(async () => []),
  count: vi.fn(async () => 0),
  objectStoreNames: { contains: vi.fn(() => false) },
};

vi.mock('idb', () => ({
  openDB: vi.fn(async () => dbMock),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('vibrdrome_stream_quality', '0');

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: {
        postMessage: vi.fn(),
      },
    },
  });

  useAuthStore.setState({
    servers: [
      {
        id: 'server-1',
        name: 'Primary',
        url: 'https://music.example.com',
        username: 'alice',
        password: 'secret',
      },
    ],
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
  });
});

describe('downloadStore', () => {
  it('dedupes queued songs for the active server', () => {
    const song = { id: 'song-1', title: 'Song 1' };

    useDownloadStore.getState().addToQueue([song]);
    useDownloadStore.getState().addToQueue([song]);

    const queue = useDownloadStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].cacheId).toBe('server-1:song-1');
  });

  it('checks cache membership per server', () => {
    useDownloadStore.setState({
      cachedSongs: new Map([
        ['server-1:song-1', {
          cacheId: 'server-1:song-1',
          songId: 'song-1',
          serverId: 'server-1',
          serverName: 'Primary',
          serverUrl: 'https://music.example.com',
          username: 'alice',
          cacheKey: 'http://localhost/__offline_audio__?server=x&user=alice&id=song-1',
          title: 'Song 1',
          size: 123,
          cachedAt: Date.now(),
        }],
      ]),
    });

    expect(useDownloadStore.getState().isCachedForServer('server-1', 'song-1')).toBe(true);
    expect(useDownloadStore.getState().isCachedForServer('server-2', 'song-1')).toBe(false);
  });

  it('removes cached audio using the canonical cache key', async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: { postMessage },
      },
    });

    useDownloadStore.setState({
      cachedSongs: new Map([
        ['server-1:song-1', {
          cacheId: 'server-1:song-1',
          songId: 'song-1',
          serverId: 'server-1',
          serverName: 'Primary',
          serverUrl: 'https://music.example.com',
          username: 'alice',
          cacheKey: 'http://localhost/__offline_audio__?server=https%3A%2F%2Fmusic.example.com&user=alice&id=song-1',
          title: 'Song 1',
          size: 123,
          cachedAt: Date.now(),
        }],
      ]),
      totalCachedSize: 123,
    });

    await useDownloadStore.getState().removeFromCache('server-1:song-1');

    expect(postMessage).toHaveBeenCalledWith({
      type: 'REMOVE_CACHED_AUDIO',
      url: 'http://localhost/__offline_audio__?server=https%3A%2F%2Fmusic.example.com&user=alice&id=song-1',
    });
    expect(useDownloadStore.getState().cachedSongs.size).toBe(0);
  });
});
