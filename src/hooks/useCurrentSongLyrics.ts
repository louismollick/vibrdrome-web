import { useEffect, useMemo, useState } from 'react';
import { getSubsonicClient } from '../api/SubsonicClient';
import { useAuthStore } from '../stores/authStore';
import { useDownloadStore } from '../stores/downloadStore';
import type { StructuredLyrics } from '../types/subsonic';
import { buildCacheId } from '../utils/downloadCache';
import { getOfflineLyrics, putOfflineLyrics } from '../utils/offlineLyricsStore';
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
  const cacheKey = activeServerId && songId ? `${activeServerId}:${songId}` : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadedLyrics, setLoadedLyrics] = useState<StructuredLyrics | null>(null);
  const [loadError, setLoadError] = useState(false);

  const cachedLyrics = cacheKey ? lyricsSessionCache.get(cacheKey) ?? null : null;

  useEffect(() => {
    if (!songId || !activeServerId || !cacheKey) return;

    let cancelled = false;

    const load = async () => {
      const persisted = await getOfflineLyrics(activeServerId, songId);
      if (cancelled) return;

      if (persisted) {
        lyricsSessionCache.set(cacheKey, persisted);
        setLoadedKey(cacheKey);
        setLoadedLyrics(persisted);
        setLoadError(false);
        return;
      }

      if (!isOnline) {
        setLoadedKey(cacheKey);
        setLoadedLyrics(null);
        setLoadError(!!cachedSong && cachedSong.lyricsStored === false);
        return;
      }

      try {
        const results = await getSubsonicClient().getLyricsBySongId(songId);
        if (cancelled) return;

        const nextLyrics = selectLyrics(results);
        if (!nextLyrics) {
          setLoadedKey(cacheKey);
          setLoadedLyrics(null);
          setLoadError(true);
          return;
        }

        await putOfflineLyrics(activeServerId, songId, nextLyrics);
        if (cancelled) return;

        lyricsSessionCache.set(cacheKey, nextLyrics);
        setLoadedKey(cacheKey);
        setLoadedLyrics(nextLyrics);
        setLoadError(false);
      } catch (err) {
        console.error('Failed to load lyrics:', err);
        if (cancelled) return;
        setLoadedKey(cacheKey);
        setLoadedLyrics(cachedLyrics);
        setLoadError(!cachedLyrics);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [activeServerId, cacheKey, cachedLyrics, cachedSong, isOnline, songId]);

  if (!songId || !activeServerId || !cacheKey) {
    return { lyrics: null, status: 'idle' as LyricsStatus };
  }

  const effectiveLyrics = loadedKey === cacheKey ? loadedLyrics : cachedLyrics;

  if (effectiveLyrics) {
    return { lyrics: effectiveLyrics, status: 'ready' as LyricsStatus };
  }

  if (cachedSong?.lyricsStored === false) {
    return { lyrics: null, status: 'error' as LyricsStatus };
  }

  if (!isOnline) {
    return { lyrics: null, status: 'offline' as LyricsStatus };
  }

  if (loadedKey !== cacheKey) {
    return { lyrics: cachedLyrics, status: 'loading' as LyricsStatus };
  }

  return {
    lyrics: null,
    status: loadError ? ('error' as LyricsStatus) : ('loading' as LyricsStatus),
  };
}
