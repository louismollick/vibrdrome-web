import { create } from 'zustand';
import { openDB } from 'idb';
import SubsonicClient from '../api/SubsonicClient';
import type { Song } from '../types/subsonic';
import { useAuthStore } from './authStore';
import { useUIStore } from './uiStore';
import { AUDIO_CACHE_NAME, ART_CACHE_NAME, buildAudioCacheKeyForServer, buildCacheId } from '../utils/downloadCache';
import { clearOfflineLyrics, deleteOfflineLyrics } from '../utils/offlineLyricsStore';
import { clearOfflineArtStore, removeArtReference } from '../utils/offlineArtStore';

const DB_NAME = 'vibrdrome_downloads';
const LEGACY_STORE_NAME = 'cached_songs';
const STORE_NAME = 'cached_songs_v2';

export type DownloadPhase = 'pending' | 'audio' | 'coverArt' | 'lyrics' | 'finalizing' | 'done' | 'error';
export type OptionalDownloadPhase = 'waveform' | 'artistInfo' | 'artistImage' | null;

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
  artistId?: string;
  album?: string;
  albumId?: string;
  track?: number;
  year?: number;
  genre?: string;
  coverArt?: string;
  duration?: number;
  discNumber?: number;
  created?: string;
  starred?: string;
  size: number;
  cachedAt: number;
  requiredAssetsReady: boolean;
  coverArtKeys?: string[];
  lyricsStored?: boolean;
  optionalAssets?: {
    waveform?: boolean;
    artistInfo?: boolean;
    artistImage?: boolean;
  };
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
  progress: number;
  requiredProgress: number;
  status: 'pending' | 'downloading' | 'done' | 'error';
  phase: DownloadPhase;
  optionalPhase: OptionalDownloadPhase;
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
  setPhase: (cacheId: string, phase: DownloadPhase, requiredProgress?: number) => void;
  markDone: (cacheId: string, payload: { size: number; coverArtKeys: string[]; lyricsStored: boolean }) => void;
  setOptionalPhase: (cacheId: string, phase: OptionalDownloadPhase) => void;
  updateCachedAssets: (cacheId: string, payload: { coverArtKeys?: string[]; lyricsStored?: boolean }) => void;
  setOptionalAsset: (cacheId: string, asset: keyof NonNullable<CachedSong['optionalAssets']>, value: boolean) => void;
  finishQueueItem: (cacheId: string) => void;
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

function normalizeCachedSong(song: CachedSong): CachedSong {
  return {
    ...song,
    requiredAssetsReady: song.requiredAssetsReady ?? true,
    coverArtKeys: song.coverArtKeys ?? [],
    optionalAssets: song.optionalAssets ? { ...song.optionalAssets } : undefined,
  };
}

async function getDb() {
  return openDB(DB_NAME, 3, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'cacheId' });
        store.createIndex('serverId', 'serverId');
        store.createIndex('albumId', 'albumId');
      }
    },
  });
}

async function persistCachedSong(song: CachedSong): Promise<void> {
  try {
    const db = await getDb();
    await db.put(STORE_NAME, song);
  } catch {
    // ignore
  }
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
    const migrated = normalizeCachedSong({
      ...row,
      cacheId: buildCacheId(activeServer.id, row.songId),
      serverId: activeServer.id,
      serverName: activeServer.name,
      serverUrl: activeServer.url,
      username: activeServer.username,
      cacheKey: buildAudioCacheKeyForServer(activeServer, row.songId),
      requiredAssetsReady: true,
    });
    await tx.objectStore(STORE_NAME).put(migrated);
  }
  await tx.objectStore(LEGACY_STORE_NAME).clear();
  await tx.done;
}

function postServiceWorkerMessage(message: object) {
  navigator.serviceWorker?.controller?.postMessage(message);
}

async function cleanupSharedAssets(song: CachedSong): Promise<void> {
  await deleteOfflineLyrics(song.serverId, song.songId);

  for (const assetKey of song.coverArtKeys ?? []) {
    const removed = await removeArtReference(assetKey);
    if (removed) {
      postServiceWorkerMessage({ type: 'REMOVE_CACHED_ART', url: assetKey });
      try {
        const cache = await caches.open(ART_CACHE_NAME);
        await cache.delete(new Request(assetKey));
      } catch {
        // ignore
      }
    }
  }
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
      .map((song) => ({
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
        requiredProgress: 0,
        status: 'pending' as const,
        phase: 'pending' as const,
        optionalPhase: null,
      }))
      .filter((item) => !existing.has(item.cacheId) && !currentQueue.some((queued) => queued.cacheId === item.cacheId));

    if (newItems.length > 0) {
      set({ queue: [...currentQueue, ...newItems] });
    }
  },

  removeFromQueue: (cacheId) => {
    set({ queue: get().queue.filter((q) => q.cacheId !== cacheId) });
  },

  updateProgress: (cacheId, progress) => {
    const clamped = Math.max(0, Math.min(1, progress));
    set({
      queue: get().queue.map((q) =>
        q.cacheId === cacheId
          ? {
            ...q,
            progress: clamped,
            requiredProgress: clamped * 0.55,
            status: 'downloading' as const,
            phase: 'audio' as const,
          }
          : q,
      ),
    });
  },

  setPhase: (cacheId, phase, requiredProgress) => {
    set({
      queue: get().queue.map((q) =>
        q.cacheId === cacheId
          ? {
            ...q,
            phase,
            progress: requiredProgress ?? q.progress,
            requiredProgress: requiredProgress ?? q.requiredProgress,
            status: phase === 'pending' ? 'pending' as const : phase === 'done' ? 'done' as const : phase === 'error' ? 'error' as const : 'downloading' as const,
          }
          : q,
      ),
    });
  },

  markDone: (cacheId, payload) => {
    const queue = get().queue;
    const item = queue.find((q) => q.cacheId === cacheId);
    if (!item) return;

    const cached = normalizeCachedSong({
      cacheId,
      songId: item.song.id,
      serverId: item.serverId,
      serverName: item.serverName,
      serverUrl: item.serverUrl,
      username: item.username,
      cacheKey: item.cacheKey,
      title: item.song.title,
      artist: item.song.artist,
      artistId: item.song.artistId,
      album: item.song.album,
      albumId: item.albumId,
      track: item.song.track,
      year: item.song.year,
      genre: item.song.genre,
      coverArt: item.song.coverArt,
      duration: item.song.duration,
      discNumber: item.song.discNumber,
      created: item.song.created,
      starred: item.song.starred,
      size: payload.size,
      cachedAt: Date.now(),
      requiredAssetsReady: true,
      coverArtKeys: payload.coverArtKeys,
      lyricsStored: payload.lyricsStored,
      optionalAssets: {},
    });

    const newCached = new Map(get().cachedSongs);
    const existing = newCached.get(cacheId);
    newCached.set(cacheId, existing ? { ...existing, ...cached } : cached);
    void persistCachedSong(newCached.get(cacheId)!);

    set({
      queue: queue.map((q) =>
        q.cacheId === cacheId
          ? { ...q, phase: 'done', status: 'done' as const, progress: 1, requiredProgress: 1 }
          : q,
      ),
      cachedSongs: newCached,
      totalCachedSize: existing ? get().totalCachedSize - existing.size + payload.size : get().totalCachedSize + payload.size,
    });
  },

  setOptionalPhase: (cacheId, phase) => {
    set({
      queue: get().queue.map((q) =>
        q.cacheId === cacheId
          ? { ...q, optionalPhase: phase }
          : q,
      ),
    });
  },

  updateCachedAssets: (cacheId, payload) => {
    const cached = get().cachedSongs.get(cacheId);
    if (!cached) return;

    const mergedCoverArtKeys = payload.coverArtKeys
      ? Array.from(new Set([...(cached.coverArtKeys ?? []), ...payload.coverArtKeys]))
      : (cached.coverArtKeys ?? []);

    const updated = normalizeCachedSong({
      ...cached,
      coverArtKeys: mergedCoverArtKeys,
      lyricsStored: payload.lyricsStored ?? cached.lyricsStored ?? false,
    });

    const newCached = new Map(get().cachedSongs);
    newCached.set(cacheId, updated);
    void persistCachedSong(updated);

    set({ cachedSongs: newCached });
  },

  setOptionalAsset: (cacheId, asset, value) => {
    const cached = get().cachedSongs.get(cacheId);
    if (!cached) return;

    const updated = normalizeCachedSong({
      ...cached,
      optionalAssets: {
        ...cached.optionalAssets,
        [asset]: value,
      },
    });

    const newCached = new Map(get().cachedSongs);
    newCached.set(cacheId, updated);
    void persistCachedSong(updated);

    set({ cachedSongs: newCached });
  },

  finishQueueItem: (cacheId) => {
    set({ queue: get().queue.filter((q) => q.cacheId !== cacheId) });
  },

  markError: (cacheId) => {
    set({
      queue: get().queue.map((q) =>
        q.cacheId === cacheId ? { ...q, status: 'error' as const, phase: 'error' as const, optionalPhase: null } : q,
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

    await cleanupSharedAssets(cached);

    postServiceWorkerMessage({
      type: 'REMOVE_CACHED_AUDIO',
      url: cached.cacheKey,
    });
    try {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      await cache.delete(new Request(cached.cacheKey));
    } catch {
      // ignore
    }

    set({
      queue: get().queue.filter((q) => q.cacheId !== cacheId),
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

    void clearOfflineLyrics();
    void clearOfflineArtStore();

    postServiceWorkerMessage({ type: 'CLEAR_AUDIO_CACHE' });
    postServiceWorkerMessage({ type: 'CLEAR_ART_CACHE' });

    set({ cachedSongs: new Map(), totalCachedSize: 0, queue: [] });
  },

  loadCachedSongs: async () => {
    try {
      const db = await getDb();
      await migrateLegacyRows(db);
      const all = await db.getAll(STORE_NAME);
      const map = new Map<string, CachedSong>();
      let totalSize = 0;
      for (const item of all as CachedSong[]) {
        const normalized = normalizeCachedSong(item);
        map.set(normalized.cacheId, normalized);
        totalSize += normalized.size;
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
