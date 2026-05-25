import { getSubsonicClient } from '../api/SubsonicClient';
import type { Song } from '../types/subsonic';

const AUTOPLAY_TARGET_SIZE = 25;
const MIN_SIMILAR_RESULTS = 10;

export type AutoplayTailStatus = 'ready' | 'fallback' | 'empty' | 'stale';

interface PrepareAutoplayTailArgs {
  seedSong: Song;
  explicitQueue: Song[];
  activeFolderId?: string;
  isStale?: () => boolean;
}

interface AutoplayTailResult {
  songs: Song[];
  status: AutoplayTailStatus;
}

function collectUniqueSongs(candidates: Song[], seenIds: Set<string>, limit: number): Song[] {
  const unique: Song[] = [];

  for (const song of candidates) {
    if (seenIds.has(song.id)) continue;
    seenIds.add(song.id);
    unique.push(song);
    if (unique.length >= limit) break;
  }

  return unique;
}

export async function prepareAutoplayTail({
  seedSong,
  explicitQueue,
  activeFolderId,
  isStale,
}: PrepareAutoplayTailArgs): Promise<AutoplayTailResult> {
  const client = getSubsonicClient();
  const seenIds = new Set(explicitQueue.map((song) => song.id));

  const similarSongs = await client.getSimilarSongs2(seedSong.id, AUTOPLAY_TARGET_SIZE).catch(() => [] as Song[]);
  if (isStale?.()) return { songs: [], status: 'stale' };

  const autoplaySongs = collectUniqueSongs(similarSongs, seenIds, AUTOPLAY_TARGET_SIZE);
  const needsFallback = autoplaySongs.length < MIN_SIMILAR_RESULTS;

  if (needsFallback) {
    const randomSongs = await client
      .getRandomSongs(AUTOPLAY_TARGET_SIZE, undefined, activeFolderId ?? undefined)
      .catch(() => [] as Song[]);
    if (isStale?.()) return { songs: [], status: 'stale' };

    autoplaySongs.push(
      ...collectUniqueSongs(randomSongs, seenIds, AUTOPLAY_TARGET_SIZE - autoplaySongs.length),
    );
  }

  if (autoplaySongs.length === 0) {
    return { songs: [], status: 'empty' };
  }

  return {
    songs: autoplaySongs,
    status: needsFallback ? 'fallback' : 'ready',
  };
}
