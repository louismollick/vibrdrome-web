import { openDB } from 'idb';

const DB_NAME = 'vibrdrome_offline_art';
const STORE_NAME = 'assets';
const DB_VERSION = 1;

export interface OfflineArtRecord {
  assetKey: string;
  coverArtId: string;
  serverId: string;
  refCount: number;
  cachedAt: number;
}

function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'assetKey' });
      }
    },
  });
}

export async function addArtReference(assetKey: string, coverArtId: string, serverId: string): Promise<number> {
  try {
    const db = await getDB();
    const existing = await db.get(STORE_NAME, assetKey) as OfflineArtRecord | undefined;
    const refCount = (existing?.refCount ?? 0) + 1;
    await db.put(STORE_NAME, {
      assetKey,
      coverArtId: existing?.coverArtId ?? coverArtId,
      serverId: existing?.serverId ?? serverId,
      refCount,
      cachedAt: existing?.cachedAt ?? Date.now(),
    } satisfies OfflineArtRecord);
    return refCount;
  } catch {
    return 0;
  }
}

export async function removeArtReference(assetKey: string): Promise<boolean> {
  try {
    const db = await getDB();
    const existing = await db.get(STORE_NAME, assetKey) as OfflineArtRecord | undefined;
    if (!existing) return true;

    if (existing.refCount <= 1) {
      await db.delete(STORE_NAME, assetKey);
      return true;
    }

    await db.put(STORE_NAME, {
      ...existing,
      refCount: existing.refCount - 1,
    } satisfies OfflineArtRecord);
    return false;
  } catch {
    return false;
  }
}

export async function clearOfflineArtStore(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear(STORE_NAME);
  } catch {
    // ignore
  }
}
