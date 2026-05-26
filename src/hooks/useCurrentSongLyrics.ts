import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSubsonicClient } from '../api/SubsonicClient';
import { useAuthStore } from '../stores/authStore';
import { useDownloadStore } from '../stores/downloadStore';
import type { StructuredLyrics } from '../types/subsonic';
import { buildCacheId } from '../utils/downloadCache';
import { deleteOfflineLyrics, getOfflineLyrics, putOfflineLyrics } from '../utils/offlineLyricsStore';
import { useOnlineStatus } from './useOnlineStatus';

const lyricsSessionCache = new Map<string, StructuredLyrics>();

type LyricsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'offline';

function selectLyrics(results: StructuredLyrics[]): StructuredLyrics | null {
  if (results.length === 0) return null;
  return results.find((item) => item.synced) ?? results[0];
}

export function useCurrentSongLyrics(songId?: string | null) {
  const isOnline = useOnlineStatus();
  const activeServerId = useAuthStore((s) => s.activeServerId);
  const cacheId = useMemo(
    () => (activeServerId && songId ? buildCacheId(activeServerId, songId) : null),
    [activeServerId, songId],
  );
  const cachedSong = useDownloadStore((s) => (cacheId ? s.cachedSongs.get(cacheId) : undefined));
  const updateCachedAssets = useDownloadStore((s) => s.updateCachedAssets);
  const cacheKey = activeServerId && songId ? `${activeServerId}:${songId}` : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadedLyrics, setLoadedLyrics] = useState<StructuredLyrics | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestIdRef = useRef(0);
  const loadedKeyRef = useRef<string | null>(null);
  const loadedLyricsRef = useRef<StructuredLyrics | null>(null);

  const cachedLyrics = cacheKey ? lyricsSessionCache.get(cacheKey) ?? null : null;
  const isDownloaded = !!cachedSong;

  useEffect(() => {
    loadedKeyRef.current = loadedKey;
    loadedLyricsRef.current = loadedLyrics;
  }, [loadedKey, loadedLyrics]);

  const storeLyrics = useCallback(async (serverId: string, id: string, lyrics: StructuredLyrics, downloaded: boolean) => {
    lyricsSessionCache.set(`${serverId}:${id}`, lyrics);
    if (downloaded) {
      await putOfflineLyrics(serverId, id, lyrics);
      if (cachedSong?.lyricsStored !== true) {
        updateCachedAssets(buildCacheId(serverId, id), { lyricsStored: true });
      }
    }
  }, [cachedSong?.lyricsStored, updateCachedAssets]);

  const clearLyrics = useCallback(async (serverId: string, id: string, downloaded: boolean) => {
    lyricsSessionCache.delete(`${serverId}:${id}`);
    if (downloaded) {
      await deleteOfflineLyrics(serverId, id);
      if (cachedSong?.lyricsStored !== false) {
        updateCachedAssets(buildCacheId(serverId, id), { lyricsStored: false });
      }
    }
  }, [cachedSong?.lyricsStored, updateCachedAssets]);

  const loadLyrics = useCallback(async ({
    forceRefresh,
    requestId,
  }: {
    forceRefresh: boolean;
    requestId: number;
  }) => {
    if (!songId || !activeServerId || !cacheKey) return;

    const applyState = (lyrics: StructuredLyrics | null, error: boolean) => {
      if (requestId !== requestIdRef.current) return;
      setLoadedKey(cacheKey);
      setLoadedLyrics(lyrics);
      setLoadError(error);
    };

    if (isDownloaded && !forceRefresh) {
      const persisted = await getOfflineLyrics(activeServerId, songId);
      if (requestId !== requestIdRef.current) return;

      if (persisted) {
        lyricsSessionCache.set(cacheKey, persisted);
        applyState(persisted, false);
        return;
      }
    }

    if (!isDownloaded) {
      const persisted = await getOfflineLyrics(activeServerId, songId);
      if (requestId !== requestIdRef.current) return;
      if (persisted) {
        void deleteOfflineLyrics(activeServerId, songId);
      }

      if (!forceRefresh && cachedLyrics) {
        applyState(cachedLyrics, false);
        return;
      }
    }

    if (!isOnline) {
      applyState(null, !!cachedSong && cachedSong.lyricsStored === false);
      return;
    }

    try {
      const results = await getSubsonicClient().getLyricsBySongId(songId);
      if (requestId !== requestIdRef.current) return;

      const nextLyrics = selectLyrics(results);
      if (!nextLyrics) {
        await clearLyrics(activeServerId, songId, isDownloaded);
        applyState(null, true);
        return;
      }

      await storeLyrics(activeServerId, songId, nextLyrics, isDownloaded);
      applyState(nextLyrics, false);
    } catch (err) {
      console.error('Failed to load lyrics:', err);
      if (requestId !== requestIdRef.current) return;

      const visibleLyrics = loadedKeyRef.current === cacheKey ? loadedLyricsRef.current : cachedLyrics;
      applyState(visibleLyrics, !visibleLyrics);
    }
  }, [
    activeServerId,
    cacheKey,
    cachedLyrics,
    cachedSong,
    clearLyrics,
    isDownloaded,
    isOnline,
    songId,
    storeLyrics,
  ]);

  useEffect(() => {
    if (!songId || !activeServerId || !cacheKey) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    void loadLyrics({ forceRefresh: false, requestId });
  }, [activeServerId, cacheKey, loadLyrics, songId]);

  const refreshLyrics = useCallback(async () => {
    if (!songId || !activeServerId || !cacheKey || !isOnline) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsRefreshing(true);
    try {
      await loadLyrics({ forceRefresh: true, requestId });
    } finally {
      if (requestId === requestIdRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [activeServerId, cacheKey, isOnline, loadLyrics, songId]);

  if (!songId || !activeServerId || !cacheKey) {
    return {
      lyrics: null,
      status: 'idle' as LyricsStatus,
      refreshLyrics,
      isRefreshing,
    };
  }

  const effectiveLyrics = loadedKey === cacheKey ? loadedLyrics : cachedLyrics;

  if (effectiveLyrics) {
    return { lyrics: effectiveLyrics, status: 'ready' as LyricsStatus, refreshLyrics, isRefreshing };
  }

  if (cachedSong?.lyricsStored === false) {
    return { lyrics: null, status: 'error' as LyricsStatus, refreshLyrics, isRefreshing };
  }

  if (!isOnline) {
    return { lyrics: null, status: 'offline' as LyricsStatus, refreshLyrics, isRefreshing };
  }

  if (loadedKey !== cacheKey) {
    return { lyrics: cachedLyrics, status: 'loading' as LyricsStatus, refreshLyrics, isRefreshing };
  }

  return {
    lyrics: null,
    status: loadError ? ('error' as LyricsStatus) : ('loading' as LyricsStatus),
    refreshLyrics,
    isRefreshing,
  };
}
