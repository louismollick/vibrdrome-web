import type { LyricLine } from '../types/subsonic';
import { getOfflineTokenizedLyrics, putOfflineTokenizedLyrics } from './offlineLyricsStore';
import {
  tokenizeText,
  type YomitanEnabledDictionaryMap,
  type YomitanToken,
} from './yomitan/core';

export interface LyricsTokenizationProgress {
  status: 'idle' | 'loading' | 'ready';
  completed: number;
  total: number;
}

export interface LyricsTokenizationSnapshot {
  tokenizedLines: Record<number, YomitanToken[]>;
  progress: LyricsTokenizationProgress;
}

interface LyricsTokenizationRequest {
  jobKey: string;
  serverId: string;
  songId: string;
  lines: LyricLine[];
  priorityIndex: number;
  preferencesFingerprint: string;
  enabledDictionaryMap: YomitanEnabledDictionaryMap;
}

interface LyricsTokenizationJobState extends LyricsTokenizationSnapshot {
  promise: Promise<void> | null;
  signature: string;
}

const jobs = new Map<string, LyricsTokenizationJobState>();
const listeners = new Map<string, Set<() => void>>();
const tokenCache = new Map<string, YomitanToken[]>();

function createIdleSnapshot(): LyricsTokenizationSnapshot {
  return {
    tokenizedLines: {},
    progress: {
      status: 'idle',
      completed: 0,
      total: 0,
    },
  };
}

function buildTokenCacheKey(
  serverId: string,
  songId: string,
  lineText: string,
  preferencesFingerprint: string,
) {
  return [serverId, songId, lineText, preferencesFingerprint].join('\u241f');
}

function buildLyricsSignature(lines: LyricLine[]) {
  return JSON.stringify(lines.map((line) => [line.start ?? null, line.value]));
}

function getTokenizationOrder(lines: LyricLine[], priorityIndex: number) {
  const indices = lines.map((_, index) => index);

  if (priorityIndex < 0 || priorityIndex >= lines.length) {
    return indices;
  }

  return indices.sort((a, b) => {
    const distanceA = Math.abs(a - priorityIndex);
    const distanceB = Math.abs(b - priorityIndex);

    if (distanceA !== distanceB) {
      return distanceA - distanceB;
    }

    return a - b;
  });
}

function updateJob(
  jobKey: string,
  updater: (current: LyricsTokenizationJobState) => LyricsTokenizationJobState,
) {
  const current = jobs.get(jobKey);
  if (!current) return;
  jobs.set(jobKey, updater(current));
  emit(jobKey);
}

function emit(jobKey: string) {
  const jobListeners = listeners.get(jobKey);
  if (!jobListeners) return;

  for (const listener of jobListeners) {
    listener();
  }
}

function isCurrentJob(jobKey: string, signature: string) {
  return jobs.get(jobKey)?.signature === signature;
}

function updateCurrentJob(
  jobKey: string,
  signature: string,
  updater: (current: LyricsTokenizationJobState) => LyricsTokenizationJobState,
) {
  if (!isCurrentJob(jobKey, signature)) return false;
  updateJob(jobKey, updater);
  return true;
}

export function buildLyricsTokenizationJobKey(
  serverId: string,
  songId: string,
  preferencesFingerprint: string,
) {
  return [serverId, songId, preferencesFingerprint].join('\u241f');
}

export function getLyricsTokenizationSnapshot(jobKey: string): LyricsTokenizationSnapshot {
  const job = jobs.get(jobKey);
  if (!job) {
    return createIdleSnapshot();
  }

  return {
    tokenizedLines: job.tokenizedLines,
    progress: job.progress,
  };
}

export function subscribeToLyricsTokenization(jobKey: string, listener: () => void) {
  const jobListeners = listeners.get(jobKey) ?? new Set<() => void>();
  jobListeners.add(listener);
  listeners.set(jobKey, jobListeners);

  return () => {
    const currentListeners = listeners.get(jobKey);
    if (!currentListeners) return;
    currentListeners.delete(listener);
    if (currentListeners.size === 0) {
      listeners.delete(jobKey);
    }
  };
}

export function clearLyricsTokenizationCache() {
  tokenCache.clear();
  jobs.clear();

  for (const jobKey of listeners.keys()) {
    emit(jobKey);
  }
}

export function resetLyricsTokenizationManagerForTests() {
  clearLyricsTokenizationCache();
  listeners.clear();
}

export function ensureLyricsTokenization(request: LyricsTokenizationRequest): Promise<void> {
  const signature = buildLyricsSignature(request.lines);
  const existingJob = jobs.get(request.jobKey);

  if (existingJob && existingJob.signature === signature) {
    return existingJob.promise ?? Promise.resolve();
  }

  const initialState: LyricsTokenizationJobState = {
    tokenizedLines: {},
    progress: {
      status: 'idle',
      completed: 0,
      total: 0,
    },
    promise: null,
    signature,
  };

  jobs.set(request.jobKey, initialState);
  emit(request.jobKey);

  const promise = (async () => {
    const persistedTokenizedLyrics = await getOfflineTokenizedLyrics(
      request.serverId,
      request.songId,
      request.preferencesFingerprint,
    );
    if (!isCurrentJob(request.jobKey, signature)) return;

    const orderedIndices = getTokenizationOrder(request.lines, request.priorityIndex);
    const cachedLines: Record<number, YomitanToken[]> = {};
    const workQueue: Array<{ index: number; line: LyricLine; key: string }> = [];

    for (const index of orderedIndices) {
      const line = request.lines[index];
      const key = buildTokenCacheKey(
        request.serverId,
        request.songId,
        line.value,
        request.preferencesFingerprint,
      );
      const cachedTokens = tokenCache.get(key) ?? persistedTokenizedLyrics?.[line.value];

      if (cachedTokens) {
        tokenCache.set(key, cachedTokens);
        cachedLines[index] = cachedTokens;
        continue;
      }

      workQueue.push({ index, line, key });
    }

    const total = orderedIndices.length;
    let completed = total - workQueue.length;

    if (!updateCurrentJob(request.jobKey, signature, (current) => ({
      ...current,
      tokenizedLines: cachedLines,
      progress: {
        status: workQueue.length === 0 ? 'ready' : 'loading',
        completed,
        total,
      },
    }))) {
      return;
    }

    if (workQueue.length === 0) {
      updateCurrentJob(request.jobKey, signature, (current) => ({
        ...current,
        promise: null,
      }));
      return;
    }

    const nextPersistedTokenizedLyrics: Record<string, YomitanToken[]> = {};

    for (const { index, line, key } of workQueue) {
      const tokens = await tokenizeText(line.value, request.enabledDictionaryMap);
      if (!isCurrentJob(request.jobKey, signature)) return;
      tokenCache.set(key, tokens);
      nextPersistedTokenizedLyrics[line.value] = tokens;
      completed += 1;

      if (!updateCurrentJob(request.jobKey, signature, (current) => ({
        ...current,
        tokenizedLines: {
          ...current.tokenizedLines,
          [index]: tokens,
        },
        progress: {
          status: completed >= total ? 'ready' : 'loading',
          completed,
          total,
        },
      }))) {
        return;
      }

      if (completed < total && typeof window !== 'undefined') {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    if (Object.keys(nextPersistedTokenizedLyrics).length > 0) {
      if (!isCurrentJob(request.jobKey, signature)) return;
      await putOfflineTokenizedLyrics(
        request.serverId,
        request.songId,
        request.preferencesFingerprint,
        nextPersistedTokenizedLyrics,
      );
    }

    updateCurrentJob(request.jobKey, signature, (current) => ({
      ...current,
      promise: null,
    }));
  })();

  updateJob(request.jobKey, (current) => ({
    ...current,
    promise,
  }));

  void promise.catch((error) => {
    console.error('Failed to tokenize lyrics for dictionary mode:', error);
    updateJob(request.jobKey, (current) => ({
      ...current,
      promise: null,
    }));
  });

  return promise;
}
