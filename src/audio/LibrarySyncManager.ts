import SubsonicClient from '../api/SubsonicClient';
import type { Song } from '../types/subsonic';
import { getDownloadManager } from './DownloadManager';
import { useAuthStore } from '../stores/authStore';
import { useDownloadStore } from '../stores/downloadStore';
import { useUIStore } from '../stores/uiStore';

const ALBUM_PAGE_SIZE = 500;
const ALBUM_CONCURRENCY = 4;
const BACKGROUND_SYNC_INTERVAL_MS = 15 * 60 * 1000;

type TriggerOptions = {
  force?: boolean;
  interrupt?: boolean;
};

class LibrarySyncManager {
  private processing = false;
  private rerunRequested = false;
  private runGeneration = 0;
  private lastBackgroundSyncAt = 0;

  trigger(reason: string, options: TriggerOptions = {}): void {
    if (!useUIStore.getState().libraryAutoSyncEnabled || !useAuthStore.getState().activeServerId) {
      return;
    }

    const isBackgroundReason = reason === 'online' || reason === 'visibility';
    if (isBackgroundReason && !options.force && Date.now() - this.lastBackgroundSyncAt < BACKGROUND_SYNC_INTERVAL_MS) {
      return;
    }

    if (options.interrupt) {
      this.runGeneration += 1;
    }

    if (this.processing) {
      this.rerunRequested = true;
      return;
    }

    void this.runLoop(!!options.force, isBackgroundReason);
  }

  stop(): void {
    this.runGeneration += 1;
    this.rerunRequested = false;
    useDownloadStore.getState().setLibrarySyncing(false);
  }

  private async runLoop(_force: boolean, isBackgroundReason: boolean): Promise<void> {
    this.processing = true;

    try {
      let nextIsBackground = isBackgroundReason;

      while (true) {
        this.rerunRequested = false;
        const generation = ++this.runGeneration;

        await this.syncOnce(generation);

        if (nextIsBackground) {
          this.lastBackgroundSyncAt = Date.now();
        }

        if (!this.rerunRequested || !useUIStore.getState().libraryAutoSyncEnabled) {
          break;
        }

        nextIsBackground = false;
      }
    } finally {
      this.processing = false;
      useDownloadStore.getState().setLibrarySyncing(false);
    }
  }

  private isCurrent(generation: number, serverId: string): boolean {
    return (
      generation === this.runGeneration &&
      useUIStore.getState().libraryAutoSyncEnabled &&
      useAuthStore.getState().activeServerId === serverId
    );
  }

  private async syncOnce(generation: number): Promise<void> {
    const downloadStore = useDownloadStore.getState();
    const { activeServerId, servers } = useAuthStore.getState();
    const activeServer = servers.find((server) => server.id === activeServerId);
    if (!activeServerId || !activeServer) {
      return;
    }

    downloadStore.setLibrarySyncing(true);
    downloadStore.setLibrarySyncStatus({ librarySyncError: null });

    try {
      const client = new SubsonicClient();
      client.setConfig(activeServer);
      const remoteSongs = await this.fetchRemoteSongs(client, generation, activeServer.id);

      if (!this.isCurrent(generation, activeServer.id)) {
        return;
      }

      const localSongs = useDownloadStore.getState().getCachedSongsForServer(activeServer.id);
      const localSongIds = new Set(localSongs.map((song) => song.songId));
      const remoteSongIds = new Set(remoteSongs.map((song) => song.id));
      const missingSongs = remoteSongs.filter((song) => !localSongIds.has(song.id));
      if (missingSongs.length > 0) {
        getDownloadManager().queueSongs(missingSongs);
      }

      for (const cached of localSongs) {
        if (!remoteSongIds.has(cached.songId)) {
          if (!this.isCurrent(generation, activeServer.id)) {
            return;
          }
          await useDownloadStore.getState().removeFromCache(cached.cacheId);
        }
      }

      if (this.isCurrent(generation, activeServer.id)) {
        useDownloadStore.getState().setLibrarySyncStatus({
          lastLibrarySyncAt: Date.now(),
          librarySyncError: null,
        });
      }
    } catch (error) {
      if (this.isCurrent(generation, activeServer.id)) {
        useDownloadStore.getState().setLibrarySyncStatus({
          librarySyncError: error instanceof Error ? error.message : 'Library sync failed',
        });
      }
    } finally {
      if (this.isCurrent(generation, activeServer.id)) {
        useDownloadStore.getState().setLibrarySyncing(false);
      }
    }
  }

  private async fetchRemoteSongs(client: SubsonicClient, generation: number, serverId: string) {
    const albums: Array<{ id: string }> = [];
    let offset = 0;

    while (true) {
      if (!this.isCurrent(generation, serverId)) {
        return [];
      }

      const page = await client.getAlbumList2('alphabeticalByName', ALBUM_PAGE_SIZE, offset);
      albums.push(...page.map((album) => ({ id: album.id })));

      if (page.length < ALBUM_PAGE_SIZE) {
        break;
      }
      offset += ALBUM_PAGE_SIZE;
    }

    const remoteById = new Map<string, Song>();
    for (let index = 0; index < albums.length; index += ALBUM_CONCURRENCY) {
      if (!this.isCurrent(generation, serverId)) {
        return [];
      }

      const batch = albums.slice(index, index + ALBUM_CONCURRENCY);
      const results = await Promise.all(batch.map((album) => client.getAlbum(album.id)));
      for (const album of results) {
        for (const song of album.song ?? []) {
          remoteById.set(song.id, song);
        }
      }
    }

    return Array.from(remoteById.values());
  }
}

let instance: LibrarySyncManager | null = null;

export function getLibrarySyncManager(): LibrarySyncManager {
  if (!instance) {
    instance = new LibrarySyncManager();
  }
  return instance;
}
