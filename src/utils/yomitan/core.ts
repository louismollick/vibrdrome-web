import type {
  ParseTextResultItem,
  Summary,
  TermDictionaryEntry,
  YomitanCore as YomitanCoreType,
} from 'yomitan-core';
import { createTermEntryRenderer as createCoreTermEntryRenderer } from 'yomitan-core/render';
import type {
  RenderHostOptions,
  RenderedTermEntry,
  TermEntryRenderer,
  TermEntryRendererCreateOptions,
} from 'yomitan-core/render';
import type { DictionaryPreference } from './preferences';

export type YomitanDictionarySummary = Summary;
export type YomitanLookupResult = {
  entries: TermDictionaryEntry[];
  originalTextLength: number;
};
export type YomitanRenderHostOptions = RenderHostOptions;
export type YomitanRenderedTermEntry = RenderedTermEntry;
export type YomitanTermEntryRenderer = TermEntryRenderer;
export type YomitanTermEntryRendererCreateOptions = TermEntryRendererCreateOptions;

export interface YomitanToken {
  text: string;
  reading: string;
  term: string;
  selectable: boolean;
  kind?: 'word' | 'punct' | 'other';
}

export type YomitanEnabledDictionaryMap = Map<string, { index: number; priority: number }>;

let corePromise: Promise<YomitanCoreType> | null = null;

function ensureBrowser() {
  if (typeof window === 'undefined') {
    throw new Error('Yomitan is only available in the browser');
  }
}

function createToken(text: string, selectable: boolean, reading = ''): YomitanToken {
  if (!text.length) {
    return {
      text,
      reading,
      term: text,
      selectable: false,
      kind: 'other',
    };
  }

  if (/^[\p{P}\p{S}]+$/u.test(text)) {
    return {
      text,
      reading,
      term: text,
      selectable: false,
      kind: 'punct',
    };
  }

  return {
    text,
    reading,
    term: text,
    selectable,
    kind: selectable ? 'word' : 'other',
  };
}

function toFindTermDictionaryMap(enabledDictionaryMap: YomitanEnabledDictionaryMap) {
  const map = new Map<
    string,
    {
      index: number;
      alias: string;
      allowSecondarySearches: boolean;
      partsOfSpeechFilter: boolean;
      useDeinflections: boolean;
    }
  >();

  for (const [name, { index }] of enabledDictionaryMap.entries()) {
    map.set(name, {
      index,
      alias: name,
      allowSecondarySearches: false,
      partsOfSpeechFilter: true,
      useDeinflections: true,
    });
  }

  return map;
}

async function getCoreInstance(): Promise<YomitanCoreType> {
  ensureBrowser();

  if (!corePromise) {
    corePromise = (async () => {
      const module = await import('yomitan-core');
      const YomitanCore = module.default;
      const core = new YomitanCore({
        databaseName: 'vibrdrome_yomitan',
        initLanguage: true,
      });
      await core.initialize();
      return core;
    })();
  }

  return await corePromise;
}

export function buildEnabledDictionaryMap(
  preferences: DictionaryPreference[],
): YomitanEnabledDictionaryMap {
  const map: YomitanEnabledDictionaryMap = new Map();

  preferences
    .filter((item) => item.enabled)
    .forEach((item, index) => {
      map.set(item.title, {
        index,
        priority: 0,
      });
    });

  return map;
}

export async function getInstalledDictionaries(): Promise<YomitanDictionarySummary[]> {
  const core = await getCoreInstance();
  const dictionaries = (await core.getDictionaryInfo()) as YomitanDictionarySummary[];
  return [...dictionaries].sort((a, b) => b.importDate - a.importDate);
}

export async function importDictionaryZip(
  archive: ArrayBuffer,
  onProgress?: (progress: { index: number; count: number; nextStep?: boolean }) => void,
) {
  const core = await getCoreInstance();
  return await core.importDictionary(archive, {
    onProgress,
    yomitanVersion: '0.0.0.0',
  });
}

export async function deleteDictionary(title: string) {
  const core = await getCoreInstance();
  await core.deleteDictionary(title);
}

export async function tokenizeText(
  text: string,
  enabledDictionaryMap: YomitanEnabledDictionaryMap,
): Promise<YomitanToken[]> {
  if (!text.length || enabledDictionaryMap.size === 0) return [];

  const core = await getCoreInstance();
  const parsed = (await core.parseText(text, {
    language: 'ja',
    enabledDictionaryMap: toFindTermDictionaryMap(enabledDictionaryMap),
    scanLength: 10,
    searchResolution: 'letter',
    removeNonJapaneseCharacters: false,
    deinflect: true,
    textReplacements: [null],
  })) as ParseTextResultItem[];

  const tokens: YomitanToken[] = [];

  for (const parseResult of parsed) {
    for (const line of parseResult.content || []) {
      for (const segment of line) {
        if (typeof segment.text !== 'string') continue;
        tokens.push(
          createToken(
            segment.text,
            Array.isArray(segment.headwords) && segment.headwords.length > 0,
            segment.reading || '',
          ),
        );
      }
    }
  }

  return tokens;
}

export async function lookupTerm(
  term: string,
  enabledDictionaryMap: YomitanEnabledDictionaryMap,
): Promise<YomitanLookupResult> {
  const core = await getCoreInstance();
  return (await core.findTerms(term, {
    mode: 'group',
    language: 'ja',
    enabledDictionaryMap: toFindTermDictionaryMap(enabledDictionaryMap),
    options: {
      matchType: 'exact',
      deinflect: true,
      removeNonJapaneseCharacters: false,
      searchResolution: 'letter',
    },
  })) as YomitanLookupResult;
}

export function createTermEntryRenderer(
  options?: YomitanTermEntryRendererCreateOptions,
): YomitanTermEntryRenderer {
  return createCoreTermEntryRenderer(options);
}
