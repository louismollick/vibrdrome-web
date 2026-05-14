import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  YOMITAN_DICTIONARY_PREFERENCES_KEY,
  loadDictionaryPreferences,
  moveDictionaryPreference,
  normalizeDictionaryPreferences,
  saveDictionaryPreferences,
} from './preferences';

describe('yomitan preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loads saved preferences after saving them', () => {
    saveDictionaryPreferences([
      { title: 'JMdict', enabled: true },
      { title: 'KANJIDIC', enabled: false },
    ]);

    expect(localStorage.getItem(YOMITAN_DICTIONARY_PREFERENCES_KEY)).toContain('JMdict');
    expect(loadDictionaryPreferences()).toEqual([
      { title: 'JMdict', enabled: true },
      { title: 'KANJIDIC', enabled: false },
    ]);
  });

  it('normalizes against installed dictionaries while preserving saved order', () => {
    const normalized = normalizeDictionaryPreferences(
      ['JMdict', 'KANJIDIC', 'JPDB Frequency'],
      [
        { title: 'KANJIDIC', enabled: false },
        { title: 'JMdict', enabled: true },
      ],
    );

    expect(normalized).toEqual([
      { title: 'KANJIDIC', enabled: false },
      { title: 'JMdict', enabled: true },
      { title: 'JPDB Frequency', enabled: true },
    ]);
  });

  it('removes deleted dictionaries from saved preferences', () => {
    const normalized = normalizeDictionaryPreferences(
      ['JMdict'],
      [
        { title: 'KANJIDIC', enabled: true },
        { title: 'JMdict', enabled: true },
      ],
    );

    expect(normalized).toEqual([
      { title: 'JMdict', enabled: true },
    ]);
  });

  it('moves dictionaries up and down in lookup order', () => {
    const preferences = [
      { title: 'JMdict', enabled: true },
      { title: 'KANJIDIC', enabled: true },
      { title: 'JPDB Frequency', enabled: true },
    ];

    expect(moveDictionaryPreference(preferences, 2, 1)).toEqual([
      { title: 'JMdict', enabled: true },
      { title: 'JPDB Frequency', enabled: true },
      { title: 'KANJIDIC', enabled: true },
    ]);

    expect(moveDictionaryPreference(preferences, 1, 1)).toBe(preferences);
  });

  it('dispatches a change event only when the stored payload changes', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    saveDictionaryPreferences([{ title: 'JMdict', enabled: true }]);
    saveDictionaryPreferences([{ title: 'JMdict', enabled: true }]);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
