import { describe, expect, it } from 'vitest';
import {
  buildNavidromeTagFilterOptions,
  filterNavidromeSongs,
  hasDuplicateNavidromeTagNames,
} from './navidromeTagFilters';
import type { NavidromeTag, SongsPageSong } from '../types/navidrome';

const songs: SongsPageSong[] = [
  {
    id: '1',
    title: 'Song 1',
    artist: 'Artist',
    genre: 'Rock',
    year: 2024,
    navidromeLyricsState: 'synced',
    navidromeTags: {
      language: ['EN'],
      mood: ['Happy'],
    },
  },
  {
    id: '2',
    title: 'Song 2',
    artist: 'Artist',
    genre: 'Rock',
    year: 2024,
    navidromeLyricsState: 'unsynced',
    navidromeTags: {
      language: ['fr'],
      mood: ['happy'],
    },
  },
];

describe('navidromeTagFilters', () => {
  it('ANDs custom tag rows together', () => {
    const filtered = filterNavidromeSongs(songs, {
      artist: '',
      genre: '',
      year: '',
      lyricsState: 'all',
      customTags: [
        { id: '1', tagName: 'language', tagValue: 'en' },
        { id: '2', tagName: 'mood', tagValue: 'happy' },
      ],
    });

    expect(filtered.map((song) => song.id)).toEqual(['1']);
  });

  it('detects duplicate tag names', () => {
    expect(hasDuplicateNavidromeTagNames([
      { id: '1', tagName: 'Language', tagValue: 'en' },
      { id: '2', tagName: 'language', tagValue: 'fr' },
    ])).toBe(true);
  });

  it('normalizes tag names and values case-insensitively', () => {
    const filtered = filterNavidromeSongs(songs, {
      artist: '',
      genre: 'rock',
      year: '2024',
      lyricsState: 'synced',
      customTags: [
        { id: '1', tagName: ' LANGUAGE ', tagValue: ' en ' },
      ],
    });

    expect(filtered.map((song) => song.id)).toEqual(['1']);
  });

  it('keeps language in custom tags and excludes built-ins', () => {
    const tags: NavidromeTag[] = [
      { id: '1', tagName: 'language', tagValue: 'en' },
      { id: '2', tagName: 'genre', tagValue: 'rock' },
      { id: '3', tagName: 'mood', tagValue: 'happy' },
      { id: '4', tagName: 'musicbrainz_albumid', tagValue: 'abc' },
    ];

    const options = buildNavidromeTagFilterOptions(tags);

    expect(options.customTagNames).toEqual(['language', 'mood']);
    expect(options.valuesByTagName.language).toEqual(['en']);
    expect(options.genres).toEqual(['rock']);
  });
});
