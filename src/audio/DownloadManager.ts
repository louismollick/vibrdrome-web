/**
 * Orchestrates sequential downloads of audio tracks for offline playback.
 * Sends tracks to the service worker cache one at a time.
 */

import { useDownloadStore } from '../stores/downloadStore';
import type { Song } from '../types/subsonic';

class DownloadManager {
  private processing = false;

  /**
   * Queue songs for download and start processing.
   */
  queueSongs(songs: Song[], albumId?: string): void {
    useDownloadStore.getState().addToQueue(songs, albumId);
    this.processQueue();
  }

  /**
   * Process the download queue sequentially.
   */
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

    store.updateProgress(cacheId, 0);

    try {
      const response = await fetch(item.downloadUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      const reader = response.body?.getReader();

      if (!reader) {
        throw new Error('No response body');
      }

      // Read the stream to track progress and collect chunks
      const chunks: BlobPart[] = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;

        if (contentLength > 0) {
          useDownloadStore.getState().updateProgress(cacheId, received / contentLength);
        }
      }

      const blob = new Blob(chunks);
      const cacheResponse = new Response(blob, {
        headers: response.headers,
      });

      const cache = await caches.open('vibrdrome-audio-v1');
      await cache.put(new Request(item.cacheKey), cacheResponse);

      useDownloadStore.getState().markDone(cacheId, received);
    } catch (err) {
      console.error(`[DownloadManager] Failed to download ${item.song.title}:`, err);
      useDownloadStore.getState().markError(cacheId);
    }
  }
}

// Singleton
let instance: DownloadManager | null = null;

export function getDownloadManager(): DownloadManager {
  if (!instance) {
    instance = new DownloadManager();
  }
  return instance;
}

export default DownloadManager;
