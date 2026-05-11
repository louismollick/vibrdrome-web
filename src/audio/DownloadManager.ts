/**
 * Orchestrates sequential downloads of audio tracks for offline playback.
 * Required assets must complete before a track is marked available offline.
 */

import SubsonicClient from '../api/SubsonicClient';
import { getLastFmArtistInfo } from '../api/LastFmClient';
import { useAuthStore } from '../stores/authStore';
import { useDownloadStore } from '../stores/downloadStore';
import { useUIStore } from '../stores/uiStore';
import type { Song, StructuredLyrics } from '../types/subsonic';
import { addArtReference, hasArtReference } from '../utils/offlineArtStore';
import { putOfflineLyrics } from '../utils/offlineLyricsStore';
import { getCachedArtist, setCachedArtist } from '../utils/lastfmCache';
import { resolveArtistImage } from '../utils/artistImageResolver';
import { extractWaveform } from './waveformExtractor';
import { AUDIO_CACHE_NAME, ART_CACHE_NAME, REQUIRED_COVER_ART_SIZES, buildCoverArtCacheKey } from '../utils/downloadCache';

const REQUIRED_PROGRESS = {
  coverArt: 0.72,
  lyrics: 0.88,
  finalizing: 0.97,
} as const;

class DownloadManager {
  private processing = false;

  queueSongs(songs: Song[], albumId?: string): void {
    useDownloadStore.getState().addToQueue(songs, albumId);
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    useDownloadStore.getState().setDownloading(true);

    while (true) {
      const { queue } = useDownloadStore.getState();
      const next = queue.find((q) => q.status === 'pending');
      if (!next) break;

      await this.downloadTrack(next.cacheId);
    }

    this.processing = false;
    useDownloadStore.getState().setDownloading(false);
  }

  private async downloadTrack(cacheId: string): Promise<void> {
    const store = useDownloadStore.getState();
    const item = store.queue.find((entry) => entry.cacheId === cacheId);
    if (!item) return;

    let audioStored = false;

    try {
      const size = await this.downloadAudio(item.cacheId, item.downloadUrl, item.cacheKey);
      audioStored = true;

      store.setPhase(cacheId, 'finalizing', REQUIRED_PROGRESS.finalizing);
      store.markDone(cacheId, {
        size,
        coverArtKeys: [],
        lyricsStored: false,
      });

      await this.runDeferredRequiredAssets(item.cacheId, item);
      await this.runOptionalEnrichments(item.cacheId, item);
      useDownloadStore.getState().finishQueueItem(item.cacheId);
    } catch (err) {
      console.error(`[DownloadManager] Failed to download ${item.song.title}:`, err);
      await this.rollbackRequiredAssets(item.cacheId, item.cacheKey, audioStored);
      useDownloadStore.getState().markError(cacheId);
    }
  }

  private async downloadAudio(cacheId: string, downloadUrl: string, cacheKey: string): Promise<number> {
    const store = useDownloadStore.getState();
    store.setPhase(cacheId, 'audio', 0);
    store.updateProgress(cacheId, 0);

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('No response body');
    }

    const chunks: BlobPart[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;

      if (contentLength > 0) {
        store.updateProgress(cacheId, received / contentLength);
      }
    }

    const blob = new Blob(chunks);
    const cacheResponse = new Response(blob, {
      headers: response.headers,
    });

    const cache = await caches.open(AUDIO_CACHE_NAME);
    await cache.put(new Request(cacheKey), cacheResponse);

    return received;
  }

  private async cacheCoverArt(item: { serverId: string; song: Song }): Promise<string[]> {
    if (!item.song.coverArt) return [];

    const server = this.getServerConfig(item.serverId);
    const client = new SubsonicClient();
    client.setConfig(server);
    const cache = await caches.open(ART_CACHE_NAME);
    const coverArtKeys: string[] = [];

    for (const size of REQUIRED_COVER_ART_SIZES) {
      const url = client.getCoverArt(item.song.coverArt, size);
      const cacheKey = buildCoverArtCacheKey(url);
      const cachedRef = await hasArtReference(cacheKey);
      if (!cachedRef) {
        const cachedResponse = await cache.match(new Request(cacheKey));
        if (!cachedResponse) {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Cover art fetch failed: ${response.status}`);
          }

          await cache.put(new Request(cacheKey), response.clone());
        }
      }

      await addArtReference(cacheKey, item.song.coverArt, item.serverId);
      coverArtKeys.push(cacheKey);
    }

    return coverArtKeys;
  }

  private async cacheLyrics(item: { serverId: string; song: Song }): Promise<boolean> {
    const server = this.getServerConfig(item.serverId);
    const client = new SubsonicClient();
    client.setConfig(server);

    const results = await client.getLyricsBySongId(item.song.id);
    const selected = this.selectLyrics(results);
    if (!selected) return false;

    await putOfflineLyrics(item.serverId, item.song.id, selected);
    return true;
  }

  private async runDeferredRequiredAssets(cacheId: string, item: { serverId: string; song: Song }): Promise<void> {
    let coverArtKeys: string[] = [];
    let lyricsStored = false;

    try {
      useDownloadStore.getState().setPhase(cacheId, 'coverArt', REQUIRED_PROGRESS.coverArt);
      coverArtKeys = await this.cacheCoverArt(item);
    } catch (err) {
      console.error(`[DownloadManager] Cover art caching failed for ${item.song.title}:`, err);
    }

    try {
      useDownloadStore.getState().setPhase(cacheId, 'lyrics', REQUIRED_PROGRESS.lyrics);
      lyricsStored = await this.cacheLyrics(item);
    } catch (err) {
      console.error(`[DownloadManager] Lyrics caching failed for ${item.song.title}:`, err);
    }

    if (coverArtKeys.length > 0 || lyricsStored) {
      useDownloadStore.getState().updateCachedAssets(cacheId, { coverArtKeys, lyricsStored });
    }
  }

  private selectLyrics(results: StructuredLyrics[]): StructuredLyrics | null {
    if (results.length === 0) return null;
    return results.find((item) => item.synced) ?? results[0];
  }

  private async runOptionalEnrichments(cacheId: string, item: { cacheKey: string; serverId: string; song: Song }): Promise<void> {
    const waveformResult = await this.runOptionalStep(cacheId, 'waveform', async () => {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      const response = await cache.match(new Request(item.cacheKey));
      if (!response) return false;
      const blob = await response.blob();
      return !!await extractWaveform(item.song.id, blob);
    });

    if (waveformResult !== null) {
      useDownloadStore.getState().setOptionalAsset(cacheId, 'waveform', waveformResult);
    }

    const artistInfoResult = await this.runOptionalStep(cacheId, 'artistInfo', async () => {
      if (!item.song.artist) return null;

      const apiKey = useUIStore.getState().lastfmApiKey;
      if (!apiKey) return null;

      const cached = await getCachedArtist(item.song.artist);
      if (cached) return true;

      const info = await getLastFmArtistInfo(item.song.artist, apiKey);
      if (info) {
        await setCachedArtist(item.song.artist, info);
        return true;
      }
      return false;
    });

    if (artistInfoResult !== null) {
      useDownloadStore.getState().setOptionalAsset(cacheId, 'artistInfo', artistInfoResult);
    }

    const artistImageResult = await this.runOptionalStep(cacheId, 'artistImage', async () => {
      if (!item.song.artist) return null;
      const server = this.getServerConfig(item.serverId);
      const client = new SubsonicClient();
      client.setConfig(server);
      const result = await resolveArtistImage(item.song.artist, client);
      return !!(result.coverArt || result.imageUrl);
    });

    if (artistImageResult !== null) {
      useDownloadStore.getState().setOptionalAsset(cacheId, 'artistImage', artistImageResult);
    }

    useDownloadStore.getState().setOptionalPhase(cacheId, null);
  }

  private async runOptionalStep(
    cacheId: string,
    phase: 'waveform' | 'artistInfo' | 'artistImage',
    task: () => Promise<boolean | null>,
  ): Promise<boolean | null> {
    try {
      useDownloadStore.getState().setOptionalPhase(cacheId, phase);
      return await task();
    } catch (err) {
      console.error(`[DownloadManager] Optional ${phase} failed:`, err);
      return false;
    }
  }

  private async rollbackRequiredAssets(
    cacheId: string,
    audioCacheKey: string,
    audioStored: boolean,
  ): Promise<void> {
    if (audioStored) {
      navigator.serviceWorker?.controller?.postMessage({ type: 'REMOVE_CACHED_AUDIO', url: audioCacheKey });
      const audioCache = await caches.open(AUDIO_CACHE_NAME);
      await audioCache.delete(new Request(audioCacheKey));
    }

    useDownloadStore.getState().setOptionalPhase(cacheId, null);
  }

  private getServerConfig(serverId: string) {
    const server = useAuthStore.getState().servers.find((entry) => entry.id === serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }
    return server;
  }
}

let instance: DownloadManager | null = null;

export function getDownloadManager(): DownloadManager {
  if (!instance) {
    instance = new DownloadManager();
  }
  return instance;
}

export default DownloadManager;
