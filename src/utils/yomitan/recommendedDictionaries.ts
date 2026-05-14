export const RECOMMENDED_DICTIONARIES = [
  {
    title: 'Jitendex',
    url: 'https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip',
  },
  {
    title: 'KANJIDIC English',
    url: 'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/KANJIDIC_english.zip',
  },
  {
    title: 'JPDB Frequency',
    url: 'https://github.com/Kuuuube/yomitan-dictionaries/raw/main/dictionaries/JPDB_v2.2_Frequency_Kana_2024-10-13.zip',
  },
  {
    title: 'JPDB Kanji',
    url: 'https://github.com/MarvNC/yomichan-dictionaries/raw/master/dl/%5BKanji%5D%20JPDB%20Kanji.zip',
  },
] as const;

export const ALLOWED_RECOMMENDED_DICTIONARY_URLS = new Set(
  RECOMMENDED_DICTIONARIES.map(({ url }) => url),
);

export function buildRecommendedDictionaryProxyUrl(url: string) {
  return `/api/recommended-dictionaries?url=${encodeURIComponent(url)}`;
}
