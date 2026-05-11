import { useMemo } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useDownloadStore } from '../stores/downloadStore';
import { buildOfflineLibrary } from '../utils/offlineLibrary';

export function useOfflineLibrary() {
  const activeServerId = useAuthStore((s) => s.activeServerId);
  const cachedSongs = useDownloadStore((s) => s.cachedSongs);

  return useMemo(() => {
    const songsForServer = Array.from(cachedSongs.values()).filter((song) => song.serverId === activeServerId);
    const snapshot = buildOfflineLibrary(songsForServer);
    return {
      ...snapshot,
      hasOfflineContent: snapshot.songs.length > 0,
    };
  }, [cachedSongs, activeServerId]);
}
