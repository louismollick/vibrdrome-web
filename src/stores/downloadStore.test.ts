import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from './authStore';
import { useDownloadStore } from './downloadStore';
import { clearOfflineLyrics, deleteOfflineLyrics } from '../utils/offlineLyricsStore';
import { removeArtReference } from '../utils/offlineArtStore';

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

vi.mock('../utils/offlineLyricsStore', () => ({
  clearOfflineLyrics: vi.fn(async () => {}),
  deleteOfflineLyrics: vi.fn(async () => {}),
}));

vi.mock('../utils/offlineArtStore', () => ({
  clearOfflineArtStore: vi.fn(async () => {}),
  hasArtReference: vi.fn(async () => false),
  removeArtReference: vi.fn(async () => true),
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

  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: vi.fn(async () => ({
        delete: vi.fn(async () => true),
      })),
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
          requiredAssetsReady: true,
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
          requiredAssetsReady: true,
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

  it('removes persisted lyrics and shared cover art references when cached audio is deleted', async () => {
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
          requiredAssetsReady: true,
          lyricsStored: true,
          coverArtKeys: ['http://localhost/__offline_cover_art__?server=https%3A%2F%2Fmusic.example.com&id=art-1&user=alice'],
        }],
      ]),
      totalCachedSize: 123,
    });

    await useDownloadStore.getState().removeFromCache('server-1:song-1');

    expect(deleteOfflineLyrics).toHaveBeenCalledWith('server-1', 'song-1');
    expect(removeArtReference).toHaveBeenCalledWith('http://localhost/__offline_cover_art__?server=https%3A%2F%2Fmusic.example.com&id=art-1&user=alice');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'REMOVE_CACHED_ART',
      url: 'http://localhost/__offline_cover_art__?server=https%3A%2F%2Fmusic.example.com&id=art-1&user=alice',
    });
  });

  it('merges deferred cached asset updates into an existing cached song', () => {
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
          requiredAssetsReady: true,
          coverArtKeys: [],
          lyricsStored: false,
        }],
      ]),
    });

    useDownloadStore.getState().updateCachedAssets('server-1:song-1', {
      coverArtKeys: ['key-a', 'key-b'],
      lyricsStored: true,
    });

    const cached = useDownloadStore.getState().cachedSongs.get('server-1:song-1');
    expect(cached?.coverArtKeys).toEqual(['key-a', 'key-b']);
    expect(cached?.lyricsStored).toBe(true);
  });

  it('reports queued state per server', () => {
    useDownloadStore.setState({
      queue: [{
        cacheId: 'server-1:song-1',
        serverId: 'server-1',
        serverName: 'Primary',
        serverUrl: 'https://music.example.com',
        username: 'alice',
        cacheKey: 'audio-key',
        downloadUrl: 'https://music.example.com/stream/song-1',
        song: { id: 'song-1', title: 'Song 1' },
        progress: 0,
        requiredProgress: 0,
        status: 'pending',
        phase: 'pending',
        optionalPhase: null,
      }],
    });

    expect(useDownloadStore.getState().isQueuedForServer('server-1', 'song-1')).toBe(true);
    expect(useDownloadStore.getState().isQueuedForServer('server-1', 'song-2')).toBe(false);
    expect(useDownloadStore.getState().isQueuedForServer('server-2', 'song-1')).toBe(false);
  });

  it('removes only downloaded songs during bulk cache eviction', async () => {
    useDownloadStore.setState({
      cachedSongs: new Map([
        ['server-1:song-1', {
          cacheId: 'server-1:song-1',
          songId: 'song-1',
          serverId: 'server-1',
          serverName: 'Primary',
          serverUrl: 'https://music.example.com',
          username: 'alice',
          cacheKey: 'audio-key-1',
          title: 'Song 1',
          size: 123,
          cachedAt: Date.now(),
          requiredAssetsReady: true,
          lyricsStored: true,
        }],
        ['server-1:song-3', {
          cacheId: 'server-1:song-3',
          songId: 'song-3',
          serverId: 'server-1',
          serverName: 'Primary',
          serverUrl: 'https://music.example.com',
          username: 'alice',
          cacheKey: 'audio-key-3',
          title: 'Song 3',
          size: 456,
          cachedAt: Date.now(),
          requiredAssetsReady: true,
          lyricsStored: true,
        }],
      ]),
      totalCachedSize: 579,
    });

    await useDownloadStore.getState().removeSongsFromCache('server-1', ['song-1', 'song-2', 'song-3']);

    expect(deleteOfflineLyrics).toHaveBeenCalledTimes(2);
    expect(deleteOfflineLyrics).toHaveBeenNthCalledWith(1, 'server-1', 'song-1');
    expect(deleteOfflineLyrics).toHaveBeenNthCalledWith(2, 'server-1', 'song-3');
    expect(useDownloadStore.getState().cachedSongs.size).toBe(0);
  });

  it('clears persisted lyrics during clear-all eviction', async () => {
    useDownloadStore.getState().clearAllCached();

    await Promise.resolve();

    expect(clearOfflineLyrics).toHaveBeenCalled();
  });
});
