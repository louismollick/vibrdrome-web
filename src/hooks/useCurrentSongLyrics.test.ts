import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCurrentSongLyrics } from './useCurrentSongLyrics';
import { useAuthStore } from '../stores/authStore';
import { useDownloadStore } from '../stores/downloadStore';
import type { StructuredLyrics } from '../types/subsonic';

const onlineStatusMocks = vi.hoisted(() => ({
  useOnlineStatus: vi.fn(() => true),
}));

const apiMocks = vi.hoisted(() => ({
  getLyricsBySongId: vi.fn(),
  setConfig: vi.fn(),
  clearNavidromeTokenCache: vi.fn(),
}));

const offlineLyricsStoreMocks = vi.hoisted(() => ({
  getOfflineLyrics: vi.fn<(serverId: string, songId: string) => Promise<StructuredLyrics | null>>(),
  putOfflineLyrics: vi.fn<(serverId: string, songId: string, lyrics: StructuredLyrics) => Promise<void>>(),
  deleteOfflineLyrics: vi.fn<(serverId: string, songId: string) => Promise<void>>(),
}));

vi.mock('../api/SubsonicClient', () => ({
  getSubsonicClient: () => ({
    getLyricsBySongId: apiMocks.getLyricsBySongId,
    setConfig: apiMocks.setConfig,
  }),
}));

vi.mock('../api/NavidromeClient', () => ({
  getNavidromeClient: () => ({
    setConfig: apiMocks.setConfig,
  }),
  clearNavidromeTokenCache: apiMocks.clearNavidromeTokenCache,
}));

vi.mock('../hooks/useOnlineStatus', () => onlineStatusMocks);
vi.mock('../utils/offlineLyricsStore', () => offlineLyricsStoreMocks);

let persistedLyricsByKey = new Map<string, StructuredLyrics>();

function makeLyrics(value: string): StructuredLyrics {
  return {
    lang: 'en',
    synced: false,
    line: [{ value }],
  };
}

describe('useCurrentSongLyrics', () => {
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
    });

    onlineStatusMocks.useOnlineStatus.mockReturnValue(true);
    apiMocks.getLyricsBySongId.mockReset();
    persistedLyricsByKey = new Map();
    offlineLyricsStoreMocks.getOfflineLyrics.mockImplementation(async (serverId: string, songId: string) => (
      persistedLyricsByKey.get(`${serverId}:${songId}`) ?? null
    ));
    offlineLyricsStoreMocks.putOfflineLyrics.mockImplementation(async (serverId: string, songId: string, lyrics: StructuredLyrics) => {
      persistedLyricsByKey.set(`${serverId}:${songId}`, lyrics);
    });
    offlineLyricsStoreMocks.deleteOfflineLyrics.mockImplementation(async (serverId: string, songId: string) => {
      persistedLyricsByKey.delete(`${serverId}:${songId}`);
    });
  });

  it('does not persist fetched lyrics for non-downloaded songs', async () => {
    apiMocks.getLyricsBySongId.mockResolvedValue([makeLyrics('fresh lyrics')]);

    const { result } = renderHook(() => useCurrentSongLyrics('song-non-downloaded-1'));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.lyrics?.line?.[0]?.value).toBe('fresh lyrics');
    expect(offlineLyricsStoreMocks.putOfflineLyrics).not.toHaveBeenCalled();
  });

  it('persists fetched lyrics for downloaded songs', async () => {
    apiMocks.getLyricsBySongId.mockResolvedValue([makeLyrics('downloaded lyrics')]);
    useDownloadStore.setState({
      cachedSongs: new Map([
        ['server-1:song-downloaded-1', {
          cacheId: 'server-1:song-downloaded-1',
          songId: 'song-downloaded-1',
          serverId: 'server-1',
          serverName: 'Primary',
          serverUrl: 'https://music.example.com',
          username: 'alice',
          cacheKey: 'audio-key',
          title: 'Downloaded song',
          size: 123,
          cachedAt: Date.now(),
          requiredAssetsReady: true,
          lyricsStored: false,
        }],
      ]),
    });

    const { result } = renderHook(() => useCurrentSongLyrics('song-downloaded-1'));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(offlineLyricsStoreMocks.putOfflineLyrics).toHaveBeenCalledWith('server-1', 'song-downloaded-1', makeLyrics('downloaded lyrics'));
  });

  it('ignores stale persisted lyrics for non-downloaded songs and deletes them opportunistically', async () => {
    persistedLyricsByKey.set('server-1:song-stale-1', makeLyrics('stale lyrics'));
    apiMocks.getLyricsBySongId.mockResolvedValue([makeLyrics('fresh lyrics')]);

    const { result } = renderHook(() => useCurrentSongLyrics('song-stale-1'));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.lyrics?.line?.[0]?.value).toBe('fresh lyrics');
    expect(offlineLyricsStoreMocks.deleteOfflineLyrics).toHaveBeenCalledWith('server-1', 'song-stale-1');
    expect(offlineLyricsStoreMocks.putOfflineLyrics).not.toHaveBeenCalled();
  });

  it('refreshes non-downloaded lyrics from the server without persisting them', async () => {
    apiMocks.getLyricsBySongId.mockResolvedValueOnce([makeLyrics('first lyrics')]).mockResolvedValueOnce([makeLyrics('refreshed lyrics')]);

    const { result } = renderHook(() => useCurrentSongLyrics('song-refresh-1'));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.lyrics?.line?.[0]?.value).toBe('first lyrics');

    await act(async () => {
      await result.current.refreshLyrics();
    });

    await waitFor(() => {
      expect(result.current.lyrics?.line?.[0]?.value).toBe('refreshed lyrics');
    });

    expect(apiMocks.getLyricsBySongId).toHaveBeenCalledTimes(2);
    expect(offlineLyricsStoreMocks.putOfflineLyrics).not.toHaveBeenCalled();
  });

  it('refresh overwrites persisted lyrics for downloaded songs', async () => {
    persistedLyricsByKey.set('server-1:song-refresh-downloaded-1', makeLyrics('persisted lyrics'));
    apiMocks.getLyricsBySongId.mockResolvedValue([makeLyrics('fresh lyrics')]);
    useDownloadStore.setState({
      cachedSongs: new Map([
        ['server-1:song-refresh-downloaded-1', {
          cacheId: 'server-1:song-refresh-downloaded-1',
          songId: 'song-refresh-downloaded-1',
          serverId: 'server-1',
          serverName: 'Primary',
          serverUrl: 'https://music.example.com',
          username: 'alice',
          cacheKey: 'audio-key',
          title: 'Downloaded song',
          size: 123,
          cachedAt: Date.now(),
          requiredAssetsReady: true,
          lyricsStored: true,
        }],
      ]),
    });

    const { result } = renderHook(() => useCurrentSongLyrics('song-refresh-downloaded-1'));

    await waitFor(() => {
      expect(result.current.lyrics?.line?.[0]?.value).toBe('persisted lyrics');
    });

    await act(async () => {
      await result.current.refreshLyrics();
    });

    await waitFor(() => {
      expect(result.current.lyrics?.line?.[0]?.value).toBe('fresh lyrics');
    });

    expect(offlineLyricsStoreMocks.putOfflineLyrics).toHaveBeenCalledWith('server-1', 'song-refresh-downloaded-1', makeLyrics('fresh lyrics'));
  });
});
