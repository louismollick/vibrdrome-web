import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LyricLine } from '../types/subsonic';
import {
  buildLyricsTokenizationJobKey,
  ensureLyricsTokenization,
  getLyricsTokenizationSnapshot,
  resetLyricsTokenizationManagerForTests,
  subscribeToLyricsTokenization,
} from './lyricsTokenizationManager';

type TestToken = {
  text: string;
  reading: string;
  term: string;
  selectable: boolean;
  kind: 'word' | 'other';
};

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const coreMocks = vi.hoisted(() => ({
  tokenizeText: vi.fn(),
}));

const offlineLyricsStoreMocks = vi.hoisted(() => ({
  getOfflineTokenizedLyrics: vi.fn(),
  putOfflineTokenizedLyrics: vi.fn(),
}));

vi.mock('./yomitan/core', async () => {
  const actual = await vi.importActual<typeof import('./yomitan/core')>('./yomitan/core');
  return {
    ...actual,
    tokenizeText: coreMocks.tokenizeText,
  };
});

vi.mock('./offlineLyricsStore', () => offlineLyricsStoreMocks);

describe('lyricsTokenizationManager', () => {
  let persistedTokenizedLyrics: Record<string, TestToken[]> | null;

  const lines: LyricLine[] = [
    { start: 0, value: '日本語猫' },
    { start: 1000, value: '次の行' },
  ];
  const enabledDictionaryMap = new Map([['JMdict', { index: 0, priority: 0 }]]);
  const preferencesFingerprint = '[["JMdict",true]]';
  const jobKey = buildLyricsTokenizationJobKey('server-1', 'song-1', preferencesFingerprint);

  beforeEach(() => {
    vi.clearAllMocks();
    resetLyricsTokenizationManagerForTests();
    persistedTokenizedLyrics = null;

    offlineLyricsStoreMocks.getOfflineTokenizedLyrics.mockImplementation(async () => persistedTokenizedLyrics);
    offlineLyricsStoreMocks.putOfflineTokenizedLyrics.mockImplementation(async (_serverId, _songId, _fingerprint, nextLines) => {
      persistedTokenizedLyrics = {
        ...(persistedTokenizedLyrics ?? {}),
        ...nextLines,
      };
    });

    coreMocks.tokenizeText.mockImplementation(async (line: string) => {
      if (line === '日本語猫') {
        return [
          { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
          { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
        ];
      }

      return [
        { text: '次', reading: 'つぎ', term: '次', selectable: true, kind: 'word' },
        { text: 'の行', reading: '', term: 'の行', selectable: false, kind: 'other' },
      ];
    });
  });

  it('updates progress incrementally while tokenization is underway', async () => {
    const firstLine = createDeferred<TestToken[]>();
    const secondLine = createDeferred<TestToken[]>();
    const snapshots: ReturnType<typeof getLyricsTokenizationSnapshot>[] = [];

    coreMocks.tokenizeText.mockImplementationOnce(() => firstLine.promise);
    coreMocks.tokenizeText.mockImplementationOnce(() => secondLine.promise);

    const unsubscribe = subscribeToLyricsTokenization(jobKey, () => {
      snapshots.push(getLyricsTokenizationSnapshot(jobKey));
    });

    const task = ensureLyricsTokenization({
      jobKey,
      serverId: 'server-1',
      songId: 'song-1',
      lines,
      priorityIndex: 0,
      preferencesFingerprint,
      enabledDictionaryMap,
    });

    await flushAsyncWork();
    expect(getLyricsTokenizationSnapshot(jobKey).progress).toEqual({
      status: 'loading',
      completed: 0,
      total: 2,
    });

    firstLine.resolve([
      { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
    ]);
    await flushAsyncWork();

    expect(getLyricsTokenizationSnapshot(jobKey).progress).toEqual({
      status: 'loading',
      completed: 1,
      total: 2,
    });
    expect(getLyricsTokenizationSnapshot(jobKey).tokenizedLines[0]).toEqual([
      { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
    ]);

    secondLine.resolve([
      { text: '次', reading: 'つぎ', term: '次', selectable: true, kind: 'word' },
      { text: 'の行', reading: '', term: 'の行', selectable: false, kind: 'other' },
    ]);
    await task;

    expect(getLyricsTokenizationSnapshot(jobKey).progress).toEqual({
      status: 'ready',
      completed: 2,
      total: 2,
    });
    expect(snapshots.some((snapshot) => snapshot.progress.completed === 1)).toBe(true);
    unsubscribe();
  });

  it('reuses persisted tokenized lyrics without retokenizing cached lines', async () => {
    persistedTokenizedLyrics = {
      日本語猫: [
        { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
        { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
      ],
    };

    await ensureLyricsTokenization({
      jobKey,
      serverId: 'server-1',
      songId: 'song-1',
      lines,
      priorityIndex: 0,
      preferencesFingerprint,
      enabledDictionaryMap,
    });

    expect(coreMocks.tokenizeText).not.toHaveBeenCalledWith('日本語猫', expect.any(Map));
    expect(coreMocks.tokenizeText).toHaveBeenCalledWith('次の行', enabledDictionaryMap);
    expect(offlineLyricsStoreMocks.putOfflineTokenizedLyrics).toHaveBeenCalledWith(
      'server-1',
      'song-1',
      preferencesFingerprint,
      {
        次の行: [
          { text: '次', reading: 'つぎ', term: '次', selectable: true, kind: 'word' },
          { text: 'の行', reading: '', term: 'の行', selectable: false, kind: 'other' },
        ],
      },
    );
  });

  it('continues tokenizing after listeners unsubscribe and does not retokenize on revisit', async () => {
    const firstLine = createDeferred<TestToken[]>();
    const secondLine = createDeferred<TestToken[]>();

    coreMocks.tokenizeText.mockImplementationOnce(() => firstLine.promise);
    coreMocks.tokenizeText.mockImplementationOnce(() => secondLine.promise);

    const unsubscribe = subscribeToLyricsTokenization(jobKey, () => {});
    const task = ensureLyricsTokenization({
      jobKey,
      serverId: 'server-1',
      songId: 'song-1',
      lines,
      priorityIndex: 0,
      preferencesFingerprint,
      enabledDictionaryMap,
    });

    unsubscribe();

    firstLine.resolve([
      { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
    ]);
    await flushAsyncWork();

    secondLine.resolve([
      { text: '次', reading: 'つぎ', term: '次', selectable: true, kind: 'word' },
      { text: 'の行', reading: '', term: 'の行', selectable: false, kind: 'other' },
    ]);
    await task;

    expect(getLyricsTokenizationSnapshot(jobKey).progress).toEqual({
      status: 'ready',
      completed: 2,
      total: 2,
    });
    expect(persistedTokenizedLyrics).toEqual({
      日本語猫: [
        { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
        { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
      ],
      次の行: [
        { text: '次', reading: 'つぎ', term: '次', selectable: true, kind: 'word' },
        { text: 'の行', reading: '', term: 'の行', selectable: false, kind: 'other' },
      ],
    });

    const tokenizeCallsBeforeRevisit = coreMocks.tokenizeText.mock.calls.length;

    await ensureLyricsTokenization({
      jobKey,
      serverId: 'server-1',
      songId: 'song-1',
      lines,
      priorityIndex: 0,
      preferencesFingerprint,
      enabledDictionaryMap,
    });

    expect(coreMocks.tokenizeText).toHaveBeenCalledTimes(tokenizeCallsBeforeRevisit);
  });
});
