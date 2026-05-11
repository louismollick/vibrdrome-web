export interface DictionaryPreference {
  title: string;
  enabled: boolean;
}

interface DictionaryPreferencesStore {
  version: 1;
  dictionaries: DictionaryPreference[];
}

export const YOMITAN_DICTIONARY_PREFERENCES_KEY = 'vibrdrome_yomitan_dictionary_preferences';
export const YOMITAN_DICTIONARY_STATE_CHANGED_EVENT = 'vibrdrome:yomitan-dictionary-state-changed';

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function notifyDictionaryStateChanged() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(YOMITAN_DICTIONARY_STATE_CHANGED_EVENT));
}

export function loadDictionaryPreferences(): DictionaryPreference[] {
  if (!isBrowser()) return [];

  try {
    const raw = localStorage.getItem(YOMITAN_DICTIONARY_PREFERENCES_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as Partial<DictionaryPreferencesStore>;
    if (!Array.isArray(parsed.dictionaries)) return [];

    return parsed.dictionaries
      .filter(
        (item): item is DictionaryPreference =>
          !!item && typeof item.title === 'string' && typeof item.enabled === 'boolean',
      )
      .map((item) => ({
        title: item.title,
        enabled: item.enabled,
      }));
  } catch (error) {
    console.error('Failed to parse Yomitan dictionary preferences:', error);
    return [];
  }
}

export function saveDictionaryPreferences(preferences: DictionaryPreference[]): void {
  if (!isBrowser()) return;

  const store: DictionaryPreferencesStore = {
    version: 1,
    dictionaries: preferences.map((item) => ({
      title: item.title,
      enabled: item.enabled,
    })),
  };

  const serialized = JSON.stringify(store);
  const previous = localStorage.getItem(YOMITAN_DICTIONARY_PREFERENCES_KEY);

  localStorage.setItem(YOMITAN_DICTIONARY_PREFERENCES_KEY, serialized);

  if (previous === serialized) return;
  notifyDictionaryStateChanged();
}

export function normalizeDictionaryPreferences(
  installedTitles: string[],
  existingPreferences: DictionaryPreference[],
): DictionaryPreference[] {
  const installedSet = new Set(installedTitles);
  const seen = new Set<string>();
  const normalized: DictionaryPreference[] = [];

  for (const preference of existingPreferences) {
    if (!installedSet.has(preference.title) || seen.has(preference.title)) continue;

    seen.add(preference.title);
    normalized.push({
      title: preference.title,
      enabled: preference.enabled,
    });
  }

  for (const title of installedTitles) {
    if (seen.has(title)) continue;
    seen.add(title);
    normalized.push({
      title,
      enabled: true,
    });
  }

  return normalized;
}

export function moveDictionaryPreference(
  preferences: DictionaryPreference[],
  fromIndex: number,
  toIndex: number,
): DictionaryPreference[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= preferences.length ||
    toIndex >= preferences.length ||
    fromIndex === toIndex
  ) {
    return preferences;
  }

  const next = [...preferences];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}
