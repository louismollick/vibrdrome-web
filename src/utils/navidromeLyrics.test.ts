import { describe, expect, it } from 'vitest';
import { getNavidromeLyricsState } from './navidromeLyrics';

describe('navidromeLyrics', () => {
  it('returns none for missing lyrics', () => {
    expect(getNavidromeLyricsState()).toBe('none');
  });

  it('returns synced when any parsed entry is synced', () => {
    expect(getNavidromeLyricsState(JSON.stringify([
      { lang: 'en', synced: false },
      { lang: 'ja', synced: true },
    ]))).toBe('synced');
  });

  it('returns unsynced when only unsynced entries exist', () => {
    expect(getNavidromeLyricsState(JSON.stringify([
      { lang: 'en', synced: false },
    ]))).toBe('unsynced');
  });

  it('returns none for invalid json', () => {
    expect(getNavidromeLyricsState('{not-json')).toBe('none');
  });
});
