import { openDB } from 'idb';
import type { StructuredLyrics } from '../types/subsonic';
import type { YomitanToken } from './yomitan/core';

const DB_NAME = 'vibrdrome_offline_lyrics';
const STORE_NAME = 'lyrics';
const DB_VERSION = 1;

export type OfflineTokenizedLyrics = Record<string, Record<string, YomitanToken[]>>;

export interface OfflineLyricsRecord {
  key: string;
  serverId: string;
  songId: string;
  lyrics: StructuredLyrics;
  cachedAt: number;
  tokenizedLyrics?: OfflineTokenizedLyrics;
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

async function getOfflineLyricsEntry(serverId: string, songId: string): Promise<OfflineLyricsRecord | null> {
  try {
    const db = await getDB();
    return await db.get(STORE_NAME, buildOfflineLyricsKey(serverId, songId)) as OfflineLyricsRecord | null;
  } catch {
    return null;
  }
}

export async function getOfflineLyrics(serverId: string, songId: string): Promise<StructuredLyrics | null> {
  const entry = await getOfflineLyricsEntry(serverId, songId);
  return entry?.lyrics ?? null;
}

export async function putOfflineLyrics(serverId: string, songId: string, lyrics: StructuredLyrics): Promise<void> {
  try {
    const db = await getDB();
    const existing = await getOfflineLyricsEntry(serverId, songId);
    await db.put(STORE_NAME, {
      key: buildOfflineLyricsKey(serverId, songId),
      serverId,
      songId,
      lyrics,
      cachedAt: Date.now(),
      tokenizedLyrics: existing?.tokenizedLyrics,
    } satisfies OfflineLyricsRecord);
  } catch {
    // ignore
  }
}

export async function getOfflineTokenizedLyrics(
  serverId: string,
  songId: string,
  preferencesFingerprint: string,
): Promise<Record<string, YomitanToken[]> | null> {
  const entry = await getOfflineLyricsEntry(serverId, songId);
  return entry?.tokenizedLyrics?.[preferencesFingerprint] ?? null;
}

export async function putOfflineTokenizedLyrics(
  serverId: string,
  songId: string,
  preferencesFingerprint: string,
  lines: Record<string, YomitanToken[]>,
): Promise<void> {
  try {
    const existing = await getOfflineLyricsEntry(serverId, songId);
    if (!existing?.lyrics) return;

    const db = await getDB();
    await db.put(STORE_NAME, {
      ...existing,
      cachedAt: Date.now(),
      tokenizedLyrics: {
        ...(existing.tokenizedLyrics ?? {}),
        [preferencesFingerprint]: {
          ...(existing.tokenizedLyrics?.[preferencesFingerprint] ?? {}),
          ...lines,
        },
      },
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
