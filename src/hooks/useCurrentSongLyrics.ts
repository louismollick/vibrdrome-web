import { useEffect, useState } from 'react';
import { getSubsonicClient } from '../api/SubsonicClient';
import { useOnlineStatus } from './useOnlineStatus';
import type { StructuredLyrics } from '../types/subsonic';

const lyricsSessionCache = new Map<string, StructuredLyrics>();

type LyricsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'offline';

export function useCurrentSongLyrics(songId?: string | null) {
  const isOnline = useOnlineStatus();
  const [loadedSongId, setLoadedSongId] = useState<string | null>(null);
  const [loadedLyrics, setLoadedLyrics] = useState<StructuredLyrics | null>(null);
  const [loadError, setLoadError] = useState(false);

  const cachedLyrics = songId ? lyricsSessionCache.get(songId) ?? null : null;
  const shouldFetch = !!songId && isOnline && songId !== loadedSongId;

  useEffect(() => {
    if (!songId || !isOnline || !shouldFetch) return;

    let cancelled = false;

    getSubsonicClient()
      .getLyricsBySongId(songId)
      .then((results) => {
        if (cancelled) return;
        if (results.length === 0) {
          setLoadedSongId(songId);
          setLoadedLyrics(null);
          setLoadError(true);
          return;
        }

        const nextLyrics = results.find((item) => item.synced) ?? results[0];
        lyricsSessionCache.set(songId, nextLyrics);
        setLoadedSongId(songId);
        setLoadedLyrics(nextLyrics);
        setLoadError(false);
      })
      .catch((err) => {
        console.error('Failed to load lyrics:', err);
        if (cancelled) return;
        setLoadedSongId(songId);
        setLoadedLyrics(cachedLyrics);
        setLoadError(!cachedLyrics);
      });

    return () => {
      cancelled = true;
    };
  }, [cachedLyrics, isOnline, shouldFetch, songId]);

  if (!songId) {
    return { lyrics: null, status: 'idle' as LyricsStatus };
  }

  if (!isOnline) {
    return {
      lyrics: cachedLyrics,
      status: cachedLyrics ? ('ready' as LyricsStatus) : ('offline' as LyricsStatus),
    };
  }

  if (shouldFetch) {
    return { lyrics: cachedLyrics, status: 'loading' as LyricsStatus };
  }

  if (loadedSongId === songId && loadedLyrics) {
    return { lyrics: loadedLyrics, status: 'ready' as LyricsStatus };
  }

  return {
    lyrics: cachedLyrics,
    status: loadError ? ('error' as LyricsStatus) : ('loading' as LyricsStatus),
  };
}
