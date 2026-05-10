import { create } from 'zustand';
import { openDB } from 'idb';
import SubsonicClient from '../api/SubsonicClient';
import type { Song } from '../types/subsonic';
import { useAuthStore } from './authStore';
import { useUIStore } from './uiStore';
import { buildAudioCacheKeyForServer, buildCacheId } from '../utils/downloadCache';

const DB_NAME = 'vibrdrome_downloads';
const LEGACY_STORE_NAME = 'cached_songs';
const STORE_NAME = 'cached_songs_v2';

export interface CachedSong {
  cacheId: string;
  songId: string;
  serverId: string;
  serverName?: string;
  serverUrl: string;
  username: string;
  cacheKey: string;
  title: string;
  artist?: string;
  album?: string;
  albumId?: string;
  coverArt?: string;
  size: number;
  cachedAt: number;
}

export interface DownloadQueueItem {
  cacheId: string;
  serverId: string;
  serverName?: string;
  serverUrl: string;
  username: string;
  cacheKey: string;
  downloadUrl: string;
  song: Song;
  albumId?: string;
  progress: number; // 0-1
  status: 'pending' | 'downloading' | 'done' | 'error';
}

interface DownloadState {
  queue: DownloadQueueItem[];
  cachedSongs: Map<string, CachedSong>;
  totalCachedSize: number;
  isDownloading: boolean;
  isLibrarySyncing: boolean;
  lastLibrarySyncAt: number | null;
  librarySyncError: string | null;

  addToQueue: (songs: Song[], albumId?: string) => void;
  removeFromQueue: (cacheId: string) => void;
  updateProgress: (cacheId: string, progress: number) => void;
  markDone: (cacheId: string, size: number) => void;
  markError: (cacheId: string) => void;
  setDownloading: (active: boolean) => void;
  setLibrarySyncing: (active: boolean) => void;
  setLibrarySyncStatus: (updates: { lastLibrarySyncAt?: number | null; librarySyncError?: string | null }) => void;
  removeFromCache: (cacheId: string) => Promise<void>;
  clearAllCached: () => void;
  loadCachedSongs: () => Promise<void>;
  isCached: (cacheId: string) => boolean;
  isCachedForServer: (serverId: string, songId: string) => boolean;
  getCachedSongsForServer: (serverId: string) => CachedSong[];
}

type LegacyCachedSong = Omit<CachedSong, 'cacheId' | 'serverId' | 'serverName' | 'serverUrl' | 'username' | 'cacheKey'>;

async function getDb() {
  return openDB(DB_NAME, 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'cacheId' });
        store.createIndex('serverId', 'serverId');
        store.createIndex('albumId', 'albumId');
      }
    },
  });
}

async function migrateLegacyRows(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  if (!db.objectStoreNames.contains(LEGACY_STORE_NAME)) return;
  if (await db.count(STORE_NAME)) return;

  const { activeServerId, servers } = useAuthStore.getState();
  const activeServer = servers.find((server) => server.id === activeServerId);
  if (!activeServer) return;

  const legacyRows = await db.getAll(LEGACY_STORE_NAME);
  if (legacyRows.length === 0) return;

  const tx = db.transaction([STORE_NAME, LEGACY_STORE_NAME], 'readwrite');
  for (const row of legacyRows as LegacyCachedSong[]) {
    const migrated: CachedSong = {
      ...row,
      cacheId: buildCacheId(activeServer.id, row.songId),
      serverId: activeServer.id,
      serverName: activeServer.name,
      serverUrl: activeServer.url,
      username: activeServer.username,
      cacheKey: buildAudioCacheKeyForServer(activeServer, row.songId),
    };
    await tx.objectStore(STORE_NAME).put(migrated);
  }
  await tx.objectStore(LEGACY_STORE_NAME).clear();
  await tx.done;
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  queue: [],
  cachedSongs: new Map(),
  totalCachedSize: 0,
  isDownloading: false,
  isLibrarySyncing: false,
  lastLibrarySyncAt: null,
  librarySyncError: null,

  addToQueue: (songs, albumId) => {
    const { activeServerId, servers } = useAuthStore.getState();
    const activeServer = servers.find((server) => server.id === activeServerId);
    if (!activeServer) return;

    const existing = get().cachedSongs;
    const currentQueue = get().queue;
    const quality = useUIStore.getState().streamQuality;
    const client = new SubsonicClient();
    client.setConfig(activeServer);

    const newItems: DownloadQueueItem[] = songs
      .map((song) => {
        return {
          cacheId: buildCacheId(activeServer.id, song.id),
          serverId: activeServer.id,
          serverName: activeServer.name,
          serverUrl: activeServer.url,
          username: activeServer.username,
          cacheKey: buildAudioCacheKeyForServer(activeServer, song.id),
          downloadUrl: client.stream(song.id, quality || undefined),
          song,
          albumId,
          progress: 0,
          status: 'pending' as const,
        };
      })
      .filter((item) => !existing.has(item.cacheId) && !currentQueue.some((queued) => queued.cacheId === item.cacheId));

    if (newItems.length > 0) {
      set({ queue: [...currentQueue, ...newItems] });
    }
  },

  removeFromQueue: (cacheId) => {
    set({ queue: get().queue.filter((q) => q.cacheId !== cacheId) });
  },

  updateProgress: (cacheId, progress) => {
    set({
      queue: get().queue.map((q) =>
        q.cacheId === cacheId ? { ...q, progress, status: 'downloading' as const } : q,
      ),
    });
  },

  markDone: (cacheId, size) => {
    const queue = get().queue;
    const item = queue.find((q) => q.cacheId === cacheId);
    if (!item) return;

    const cached: CachedSong = {
      cacheId,
      songId: item.song.id,
      serverId: item.serverId,
      serverName: item.serverName,
      serverUrl: item.serverUrl,
      username: item.username,
      cacheKey: item.cacheKey,
      title: item.song.title,
      artist: item.song.artist,
      album: item.song.album,
      albumId: item.albumId,
      coverArt: item.song.coverArt,
      size,
      cachedAt: Date.now(),
    };

    const newCached = new Map(get().cachedSongs);
    newCached.set(cacheId, cached);

    getDb().then((db) => db.put(STORE_NAME, cached)).catch(() => {});

    set({
      queue: queue.filter((q) => q.cacheId !== cacheId),
      cachedSongs: newCached,
      totalCachedSize: get().totalCachedSize + size,
    });
  },

  markError: (cacheId) => {
    set({
      queue: get().queue.map((q) =>
        q.cacheId === cacheId ? { ...q, status: 'error' as const } : q,
      ),
    });
  },

  setDownloading: (active) => set({ isDownloading: active }),
  setLibrarySyncing: (active) => set({ isLibrarySyncing: active }),
  setLibrarySyncStatus: (updates) => set((state) => ({
    lastLibrarySyncAt: updates.lastLibrarySyncAt ?? state.lastLibrarySyncAt,
    librarySyncError: updates.librarySyncError ?? state.librarySyncError,
  })),

  removeFromCache: async (cacheId) => {
    const cached = get().cachedSongs.get(cacheId);
    if (!cached) return;

    const newCached = new Map(get().cachedSongs);
    newCached.delete(cacheId);

    try {
      const db = await getDb();
      await db.delete(STORE_NAME, cacheId);
    } catch {
      // ignore
    }

    navigator.serviceWorker?.controller?.postMessage({
      type: 'REMOVE_CACHED_AUDIO',
      url: cached.cacheKey,
    });

    set({
      cachedSongs: newCached,
      totalCachedSize: Math.max(0, get().totalCachedSize - cached.size),
    });
  },

  clearAllCached: () => {
    getDb().then(async (db) => {
      await db.clear(STORE_NAME);
      if (db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        await db.clear(LEGACY_STORE_NAME);
      }
    }).catch(() => {});

    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_AUDIO_CACHE' });

    set({ cachedSongs: new Map(), totalCachedSize: 0, queue: [] });
  },

  loadCachedSongs: async () => {
    try {
      const db = await getDb();
      await migrateLegacyRows(db);
      const all = await db.getAll(STORE_NAME);
      const map = new Map<string, CachedSong>();
      let totalSize = 0;
      for (const item of all) {
        map.set(item.cacheId, item);
        totalSize += item.size;
      }
      set({ cachedSongs: map, totalCachedSize: totalSize });
    } catch {
      // ignore
    }
  },

  isCached: (cacheId) => get().cachedSongs.has(cacheId),
  isCachedForServer: (serverId, songId) => get().cachedSongs.has(buildCacheId(serverId, songId)),
  getCachedSongsForServer: (serverId) => Array.from(get().cachedSongs.values()).filter((item) => item.serverId === serverId),
}));
