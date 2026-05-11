import { openDB } from 'idb';
import type { StructuredLyrics } from '../types/subsonic';

const DB_NAME = 'vibrdrome_offline_lyrics';
const STORE_NAME = 'lyrics';
const DB_VERSION = 1;

export interface OfflineLyricsRecord {
  key: string;
  serverId: string;
  songId: string;
  lyrics: StructuredLyrics;
  cachedAt: number;
}

export function buildOfflineLyricsKey(serverId: string, songId: string): string {
  return `${serverId}:${songId}`;
}

function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    },
  });
}

export async function getOfflineLyrics(serverId: string, songId: string): Promise<StructuredLyrics | null> {
  try {
    const db = await getDB();
    const entry = await db.get(STORE_NAME, buildOfflineLyricsKey(serverId, songId)) as OfflineLyricsRecord | undefined;
    return entry?.lyrics ?? null;
  } catch {
    return null;
  }
}

export async function putOfflineLyrics(serverId: string, songId: string, lyrics: StructuredLyrics): Promise<void> {
  try {
    const db = await getDB();
    await db.put(STORE_NAME, {
      key: buildOfflineLyricsKey(serverId, songId),
      serverId,
      songId,
      lyrics,
      cachedAt: Date.now(),
    } satisfies OfflineLyricsRecord);
  } catch {
    // ignore
  }
}

export async function deleteOfflineLyrics(serverId: string, songId: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete(STORE_NAME, buildOfflineLyricsKey(serverId, songId));
  } catch {
    // ignore
  }
}

export async function clearOfflineLyrics(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear(STORE_NAME);
  } catch {
    // ignore
  }
}
