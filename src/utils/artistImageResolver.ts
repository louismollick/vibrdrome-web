import SubsonicClient, { getSubsonicClient } from '../api/SubsonicClient';
import { getArtistImageUrl } from '../api/ArtistImageClient';

export interface ArtistImageResult {
  imageUrl: string | null;
  artistId: string | null;
  coverArt: string | null;
}

const EMPTY: ArtistImageResult = { imageUrl: null, artistId: null, coverArt: null };
const RESOLVED_CACHE_MAX = 200;
const resolvedCache = new Map<string, ArtistImageResult>();
const pendingResolves = new Map<string, Promise<ArtistImageResult>>();

export async function resolveArtistImage(artistName: string, client: SubsonicClient = getSubsonicClient()): Promise<ArtistImageResult> {
  const cacheKey = `img:${artistName.toLowerCase()}`;

  const cached = resolvedCache.get(cacheKey);
  if (cached && cached.imageUrl) return cached;

  const pending = pendingResolves.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<ArtistImageResult> => {
    let foundArtistId: string | null = null;

    try {
      const searchResult = await client.search3(artistName, 5, 0, 0);
      const artists = searchResult.artist ?? [];
      const match = artists.find((a) => a.name.toLowerCase() === artistName.toLowerCase()) ?? artists[0];
      if (match) {
        foundArtistId = match.id;
        const coverArt = match.coverArt ?? null;
        if (coverArt) {
          const url = client.getCoverArt(coverArt, 150);
          const result = { imageUrl: url, artistId: match.id, coverArt };
          if (resolvedCache.size >= RESOLVED_CACHE_MAX) {
            const key = resolvedCache.keys().next().value;
            if (key !== undefined) resolvedCache.delete(key);
          }
          resolvedCache.set(cacheKey, result);
          return result;
        }
      }
    } catch {
      // continue
    }

    try {
      const wikiImageUrl = await getArtistImageUrl(artistName);
      if (wikiImageUrl) {
        const result = { imageUrl: wikiImageUrl, artistId: foundArtistId, coverArt: null };
        if (resolvedCache.size >= RESOLVED_CACHE_MAX) {
          const key = resolvedCache.keys().next().value;
          if (key !== undefined) resolvedCache.delete(key);
        }
        resolvedCache.set(cacheKey, result);
        return result;
      }
    } catch {
      // continue
    }

    const result = { ...EMPTY, artistId: foundArtistId };
    resolvedCache.set(cacheKey, result);
    return result;
  })();

  pendingResolves.set(cacheKey, promise);
  promise.finally(() => pendingResolves.delete(cacheKey));

  return promise;
}
