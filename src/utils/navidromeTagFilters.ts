import type { NavidromeLyricsState, NavidromeTag, SongsPageSong } from '../types/navidrome';

export interface NavidromeCustomTagFilter {
  id: string;
  tagName: string;
  tagValue: string;
}

export interface NavidromeTagFilterOptions {
  customTagNames: string[];
  valuesByTagName: Record<string, string[]>;
  genres: string[];
}

const EXCLUDED_TAG_NAMES = new Set([
  'album',
  'title',
  'track',
  'tracktotal',
  'disc',
  'disctotal',
  'artist',
  'artists',
  'albumartist',
  'albumartists',
  'genre',
  'lyrics',
  'titlesort',
  'albumsort',
  'artistsort',
  'artistssort',
  'albumartistsort',
  'albumartistssort',
  'recordingdate',
  'originaldate',
  'releasedate',
  'r128_album_gain',
  'r128_track_gain',
]);

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeNavidromeTagName(tagName: string) {
  return normalizeWhitespace(tagName).toLowerCase();
}

export function normalizeNavidromeTagValue(tagValue: string) {
  return normalizeWhitespace(tagValue).toLowerCase();
}

function shouldExcludeCustomTag(tagName: string) {
  const normalized = normalizeNavidromeTagName(tagName);
  return EXCLUDED_TAG_NAMES.has(normalized)
    || normalized.startsWith('musicbrainz_')
    || normalized.startsWith('replaygain_');
}

export function hasDuplicateNavidromeTagNames(filters: NavidromeCustomTagFilter[]) {
  const names = filters
    .map((filter) => normalizeNavidromeTagName(filter.tagName))
    .filter(Boolean);

  return new Set(names).size !== names.length;
}

export function buildNavidromeTagFilterOptions(tags: NavidromeTag[]): NavidromeTagFilterOptions {
  const customValuesByName = new Map<string, Map<string, string>>();
  const genreValues = new Map<string, string>();

  for (const tag of tags) {
    const normalizedName = normalizeNavidromeTagName(tag.tagName);
    const normalizedValue = normalizeNavidromeTagValue(tag.tagValue);

    if (!normalizedName || !normalizedValue) continue;

    if (normalizedName === 'genre') {
      if (!genreValues.has(normalizedValue)) {
        genreValues.set(normalizedValue, normalizeWhitespace(tag.tagValue));
      }
    }

    if (shouldExcludeCustomTag(normalizedName)) continue;

    const values = customValuesByName.get(normalizedName) ?? new Map<string, string>();
    if (!customValuesByName.has(normalizedName)) {
      customValuesByName.set(normalizedName, values);
    }
    if (!values.has(normalizedValue)) {
      values.set(normalizedValue, normalizeWhitespace(tag.tagValue));
    }
  }

  const customTagNames = Array.from(customValuesByName.keys()).sort((a, b) => a.localeCompare(b));
  const valuesByTagName = Object.fromEntries(
    Array.from(customValuesByName.entries()).map(([tagName, values]) => [
      tagName,
      Array.from(values.values()).sort((a, b) => a.localeCompare(b)),
    ]),
  );

  return {
    customTagNames,
    valuesByTagName,
    genres: Array.from(genreValues.values()).sort((a, b) => a.localeCompare(b)),
  };
}

export function filterNavidromeSongs(
  songs: SongsPageSong[],
  filters: {
    artist: string;
    genre: string;
    year: string;
    lyricsState: 'all' | NavidromeLyricsState;
    customTags: NavidromeCustomTagFilter[];
  },
) {
  const normalizedArtist = filters.artist.trim().toLowerCase();
  const normalizedGenre = normalizeNavidromeTagValue(filters.genre);
  const normalizedYear = filters.year.trim();

  return songs.filter((song) => {
    if (normalizedArtist && !song.artist?.toLowerCase().includes(normalizedArtist)) {
      return false;
    }

    if (normalizedGenre && normalizeNavidromeTagValue(song.genre ?? '') !== normalizedGenre) {
      return false;
    }

    if (normalizedYear) {
      const year = Number(normalizedYear);
      if (Number.isNaN(year) || song.year !== year) {
        return false;
      }
    }

    if (filters.lyricsState !== 'all' && song.navidromeLyricsState !== filters.lyricsState) {
      return false;
    }

    return filters.customTags.every((filter) => {
      const tagName = normalizeNavidromeTagName(filter.tagName);
      const tagValue = normalizeNavidromeTagValue(filter.tagValue);
      const songValues = song.navidromeTags?.[tagName] ?? [];
      return songValues.some((value) => normalizeNavidromeTagValue(value) === tagValue);
    });
  });
}
