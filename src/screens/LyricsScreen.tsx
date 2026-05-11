import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { usePlayerStore } from '../stores/playerStore';
import { useUIStore } from '../stores/uiStore';
import { getPlaybackManager } from '../audio/PlaybackManager';
import type { LyricLine } from '../types/subsonic';
import { Header, LoadingSpinner, StateMessage } from '../components/common';
import YomitanOverlay from '../components/lyrics/YomitanOverlay';
import { useCurrentSongLyrics } from '../hooks/useCurrentSongLyrics';
import { getOfflineMessage } from '../utils/offlineCapability';
import {
  buildEnabledDictionaryMap,
  getInstalledDictionaries,
  tokenizeText,
  type YomitanDictionarySummary,
  type YomitanToken,
} from '../utils/yomitan/core';
import {
  YOMITAN_DICTIONARY_STATE_CHANGED_EVENT,
  loadDictionaryPreferences,
  normalizeDictionaryPreferences,
  saveDictionaryPreferences,
  type DictionaryPreference,
} from '../utils/yomitan/preferences';

function getCurrentLineIndex(lines: LyricLine[], positionMs: number): number {
  let currentIdx = -1;

  for (let index = 0; index < lines.length; index++) {
    const start = lines[index].start ?? 0;
    if (start <= positionMs) {
      currentIdx = index;
    } else {
      break;
    }
  }

  return currentIdx;
}

function buildTokenCacheKey(
  serverId: string,
  songId: string,
  lineText: string,
  preferencesFingerprint: string,
) {
  return [serverId, songId, lineText, preferencesFingerprint].join('\u241f');
}

function getSyncedLineClass(index: number, currentIdx: number) {
  if (index === currentIdx) {
    return 'scale-105 text-xl font-bold text-accent';
  }

  if (index < currentIdx) {
    return 'text-lg font-medium text-text-muted';
  }

  return 'text-lg font-medium text-text-secondary';
}

function renderPlainLine(line: LyricLine) {
  return line.value || '\u00A0';
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

export default function LyricsScreen() {
  const navigate = useNavigate();
  const activeServerId = useAuthStore((state) => state.activeServerId);
  const currentSong = usePlayerStore((state) => state.currentSong);
  const positionMs = usePlayerStore((state) => state.positionMs);
  const lyricsInteractionMode = useUIStore((state) => state.lyricsInteractionMode);
  const setLyricsInteractionMode = useUIStore((state) => state.setLyricsInteractionMode);
  const { lyrics, status } = useCurrentSongLyrics(currentSong?.id);

  const [installedDictionaries, setInstalledDictionaries] = useState<YomitanDictionarySummary[]>([]);
  const [dictionaryPreferences, setDictionaryPreferences] = useState<DictionaryPreference[]>([]);
  const [dictionaryStateLoaded, setDictionaryStateLoaded] = useState(false);
  const [dictionaryStateError, setDictionaryStateError] = useState(false);
  const [tokenizedLines, setTokenizedLines] = useState<Record<number, YomitanToken[]>>({});
  const [tokenizationProgress, setTokenizationProgress] = useState<{
    status: 'idle' | 'loading' | 'ready';
    completed: number;
    total: number;
  }>({
    status: 'idle',
    completed: 0,
    total: 0,
  });
  const [overlayState, setOverlayState] = useState<{
    lineIndex: number;
    tokenIndex: number;
    sessionKey: string;
  } | null>(null);

  const currentLineRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastLineIdxRef = useRef(-1);
  const dictionaryPriorityLineIndexRef = useRef(-1);
  const tokenCacheRef = useRef<Map<string, YomitanToken[]>>(new Map());
  const offlineLyricsMessage = getOfflineMessage('lyrics');

  const currentLineIndex = lyrics?.line ? getCurrentLineIndex(lyrics.line, positionMs) : -1;
  const overlaySessionKey = `${currentSong?.id ?? ''}:${lyricsInteractionMode}`;
  const activeOverlayState = overlayState?.sessionKey === overlaySessionKey ? overlayState : null;
  const dictionaryPreferenceFingerprint = useMemo(
    () => JSON.stringify(dictionaryPreferences.map(({ title, enabled }) => [title, enabled])),
    [dictionaryPreferences],
  );
  const enabledDictionaryMap = useMemo(
    () => buildEnabledDictionaryMap(dictionaryPreferences),
    [dictionaryPreferences],
  );

  const refreshDictionaryState = useEffectEvent(async () => {
    try {
      setDictionaryStateLoaded(false);
      setDictionaryStateError(false);

      const installed = await getInstalledDictionaries();
      const normalizedPreferences = normalizeDictionaryPreferences(
        installed.map((item) => item.title),
        loadDictionaryPreferences(),
      );

      saveDictionaryPreferences(normalizedPreferences);
      setInstalledDictionaries(installed);
      setDictionaryPreferences(normalizedPreferences);
    } catch (error) {
      console.error('Failed to load Yomitan state for lyrics:', error);
      setInstalledDictionaries([]);
      setDictionaryPreferences([]);
      setDictionaryStateError(true);
    } finally {
      setDictionaryStateLoaded(true);
    }
  });

  useEffect(() => {
    dictionaryPriorityLineIndexRef.current = currentLineIndex;
  }, [currentLineIndex]);

  useEffect(() => {
    if (lyricsInteractionMode !== 'dictionary') return;
    queueMicrotask(() => {
      void refreshDictionaryState();
    });
  }, [lyricsInteractionMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleDictionaryStateChanged = () => {
      tokenCacheRef.current.clear();
      if (lyricsInteractionMode === 'dictionary') {
        void refreshDictionaryState();
      }
    };

    window.addEventListener(YOMITAN_DICTIONARY_STATE_CHANGED_EVENT, handleDictionaryStateChanged);
    return () => {
      window.removeEventListener(YOMITAN_DICTIONARY_STATE_CHANGED_EVENT, handleDictionaryStateChanged);
    };
  }, [lyricsInteractionMode]);

  useEffect(() => {
    if (
      lyricsInteractionMode !== 'dictionary' ||
      status !== 'ready' ||
      !lyrics?.line ||
      !currentSong?.id ||
      !activeServerId ||
      enabledDictionaryMap.size === 0
    ) {
      queueMicrotask(() => {
        setTokenizedLines({});
        setTokenizationProgress({
          status: 'idle',
          completed: 0,
          total: 0,
        });
      });
      return;
    }

    let cancelled = false;

    const tokenizeLines = async () => {
      const orderedIndices = getTokenizationOrder(
        lyrics.line!,
        lyrics.synced ? dictionaryPriorityLineIndexRef.current : -1,
      );
      const cachedLines: Record<number, YomitanToken[]> = {};
      const workQueue: Array<{ index: number; line: LyricLine; key: string }> = [];

      for (const index of orderedIndices) {
        const line = lyrics.line![index];
        const key = buildTokenCacheKey(
          activeServerId,
          currentSong.id,
          line.value,
          dictionaryPreferenceFingerprint,
        );
        const cachedTokens = tokenCacheRef.current.get(key);

        if (cachedTokens) {
          cachedLines[index] = cachedTokens;
          continue;
        }

        workQueue.push({ index, line, key });
      }

      if (cancelled) return;

      setTokenizedLines(cachedLines);

      const total = orderedIndices.length;
      let completed = total - workQueue.length;

      setTokenizationProgress({
        status: workQueue.length === 0 ? 'ready' : 'loading',
        completed,
        total,
      });

      if (workQueue.length === 0) {
        return;
      }

      const batchSize = 1;

      for (let offset = 0; offset < workQueue.length; offset += batchSize) {
        const batch = workQueue.slice(offset, offset + batchSize);
        const resolvedBatch = await Promise.all(
          batch.map(async ({ index, line, key }) => {
            const tokens = await tokenizeText(line.value, enabledDictionaryMap);
            tokenCacheRef.current.set(key, tokens);
            return { index, tokens };
          }),
        );

        if (cancelled) return;

        setTokenizedLines((current) => {
          const next = { ...current };

          for (const { index, tokens } of resolvedBatch) {
            next[index] = tokens;
          }

          return next;
        });

        completed += resolvedBatch.length;
        setTokenizationProgress({
          status: completed >= total ? 'ready' : 'loading',
          completed,
          total,
        });

        if (completed < total) {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
      }
    };

    void tokenizeLines();

    return () => {
      cancelled = true;
    };
  }, [
    activeServerId,
    currentSong?.id,
    dictionaryPreferenceFingerprint,
    enabledDictionaryMap,
    lyrics?.line,
    lyrics?.synced,
    lyricsInteractionMode,
    status,
  ]);

  useEffect(() => {
    if (!lyrics?.synced) return;
    if (!currentLineRef.current || !containerRef.current) return;

    const element = currentLineRef.current;
    const container = containerRef.current;
    const idx = Number(element.dataset.lineIdx ?? '-1');

    if (idx === -1 || idx === lastLineIdxRef.current) return;

    lastLineIdxRef.current = idx;

    const elementTop = element.offsetTop - container.offsetTop;
    const elementHeight = element.offsetHeight;
    const containerHeight = container.clientHeight;
    const targetScroll = elementTop - containerHeight / 2 + elementHeight / 2;

    container.scrollTo({ top: targetScroll, behavior: 'smooth' });
  }, [currentLineIndex, lyrics?.synced, positionMs]);

  const canUseDictionaryMode =
    dictionaryStateLoaded && !dictionaryStateError && installedDictionaries.length > 0 && enabledDictionaryMap.size > 0;
  const isTokenizingDictionaryMode =
    canUseDictionaryMode &&
    tokenizationProgress.status === 'loading' &&
    tokenizationProgress.completed < tokenizationProgress.total;
  const dictionaryModeMessage = dictionaryStateError
    ? 'Yomitan dictionaries could not be loaded. Open Settings to refresh or re-import dictionaries.'
    : installedDictionaries.length === 0
      ? 'No Yomitan dictionaries are installed. Add dictionary ZIPs in Settings to use dictionary mode.'
      : enabledDictionaryMap.size === 0
        ? 'All Yomitan dictionaries are disabled. Re-enable one in Settings to use dictionary mode.'
        : null;

  const overlayTokens = activeOverlayState ? tokenizedLines[activeOverlayState.lineIndex] ?? [] : [];
  const setCurrentLineElement = (element: HTMLElement | null) => {
    currentLineRef.current = element;
  };

  const rightActions = (
    <div className="flex items-center rounded-full border border-border bg-bg-secondary/80 p-1">
      <button
        onClick={() => setLyricsInteractionMode('seek')}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          lyricsInteractionMode === 'seek'
            ? 'bg-accent text-white'
            : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
        }`}
        aria-label="Seek mode"
        title="Seek mode"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="h-4 w-4"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h8M4 12h16M4 18h8" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l5 6-5 6" />
        </svg>
      </button>
      <button
        onClick={() => setLyricsInteractionMode('dictionary')}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          lyricsInteractionMode === 'dictionary'
            ? 'bg-accent text-white'
            : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
        }`}
        aria-label="Dictionary mode"
        title="Dictionary mode"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="h-4 w-4"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5A2.5 2.5 0 016.5 17H20" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.5 17A2.5 2.5 0 014 14.5v-9A2.5 2.5 0 016.5 3H20v14" />
        </svg>
      </button>
    </div>
  );

  const renderDictionaryTokens = (tokens: YomitanToken[], lineIndex: number) => {
    const hasSelectableTokens = tokens.some((token) => token.selectable);
    if (!hasSelectableTokens) {
      return null;
    }

    return tokens.map((token, tokenIndex) => {
      if (token.selectable) {
        const selected =
          activeOverlayState?.lineIndex === lineIndex && activeOverlayState.tokenIndex === tokenIndex;

        return (
          <button
            key={`${lineIndex}-${tokenIndex}-${token.text}`}
            type="button"
            onClick={() => setOverlayState({ lineIndex, tokenIndex, sessionKey: overlaySessionKey })}
            className={`relative inline-block rounded-sm px-px transition-colors after:pointer-events-none after:absolute after:right-px after:bottom-[0.1em] after:left-px after:h-px after:rounded-full after:content-[''] ${
              selected
                ? 'text-accent after:bg-accent'
                : 'after:bg-accent/70 hover:text-accent hover:after:bg-accent'
            }`}
          >
            {token.text}
          </button>
        );
      }

      return (
        <span key={`${lineIndex}-${tokenIndex}-${token.text}`}>
          {token.text}
        </span>
      );
    });
  };

  const renderDictionaryLyrics = (lines: LyricLine[], synced: boolean) => (
    <div className={`py-4 ${synced ? 'space-y-3' : 'space-y-2'}`}>
      {dictionaryModeMessage && dictionaryStateLoaded && (
        <div className="rounded-xl border border-border bg-bg-secondary/60 px-4 py-3 text-sm text-text-secondary">
          <p>{dictionaryModeMessage}</p>
          <button
            onClick={() => navigate('/settings')}
            className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            Open Settings
          </button>
        </div>
      )}

      {isTokenizingDictionaryMode && (
        <div className="rounded-xl border border-border bg-bg-secondary/60 px-4 py-3 text-sm text-text-secondary">
          <div className="flex items-center gap-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-bg-tertiary border-t-accent" />
            <div>
              <p className="font-medium text-text-primary">Preparing dictionary mode…</p>
              <p className="text-xs text-text-muted">
                Tokenized {tokenizationProgress.completed} of {tokenizationProgress.total} lines
              </p>
            </div>
          </div>
        </div>
      )}

      {lines.map((line, index) => {
        const isCurrent = synced && index === currentLineIndex;
        const tokens = canUseDictionaryMode ? tokenizedLines[index] ?? [] : [];
        const renderedTokens = canUseDictionaryMode ? renderDictionaryTokens(tokens, index) : null;

        return (
          <div
            key={index}
            ref={isCurrent ? setCurrentLineElement : undefined}
            data-line-idx={index}
            className={`w-full whitespace-pre-wrap text-left ${
              synced ? getSyncedLineClass(index, currentLineIndex) : 'text-base text-text-primary'
            }`}
          >
            {renderedTokens ?? renderPlainLine(line)}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <Header title="Lyrics" showBack rightActions={rightActions} />

      {currentSong && (
        <div className="px-4 pb-3">
          <h2 className="truncate text-lg font-bold text-text-primary">{currentSong.title}</h2>
          <p className="truncate text-sm text-text-secondary">{currentSong.artist}</p>
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 pb-20">
        {status === 'loading' && <LoadingSpinner />}

        {status !== 'loading' && !currentSong && (
          <StateMessage title="No song playing" className="h-full" />
        )}

        {status === 'offline' && currentSong && (
          <StateMessage title={offlineLyricsMessage.title} body={offlineLyricsMessage.body} className="h-full" />
        )}

        {status === 'error' && currentSong && (
          <StateMessage title="No lyrics available" className="h-full" />
        )}

        {status === 'ready' && lyrics && lyrics.synced && lyrics.line && lyricsInteractionMode === 'seek' && (
          <div className="space-y-3 py-4">
            {lyrics.line.map((line, index) => {
              const isCurrent = index === currentLineIndex;

              return (
                <button
                  key={index}
                  ref={isCurrent ? setCurrentLineElement : undefined}
                  data-line-idx={index}
                  onClick={() => {
                    if (line.start !== undefined) {
                      getPlaybackManager().seek(line.start);
                      usePlayerStore.getState().setPosition(line.start);
                    }
                  }}
                  className={`block w-full text-left transition-all duration-300 ${
                    getSyncedLineClass(index, currentLineIndex)
                  }`}
                >
                  {renderPlainLine(line)}
                </button>
              );
            })}
          </div>
        )}

        {status === 'ready' && lyrics && lyrics.synced && lyrics.line && lyricsInteractionMode === 'dictionary' && (
          renderDictionaryLyrics(lyrics.line, true)
        )}

        {status === 'ready' && lyrics && !lyrics.synced && lyrics.line && lyricsInteractionMode === 'seek' && (
          <div className="space-y-2 py-4">
            {lyrics.line.map((line, index) => (
              <p key={index} className="text-base text-text-primary">
                {renderPlainLine(line)}
              </p>
            ))}
          </div>
        )}

        {status === 'ready' && lyrics && !lyrics.synced && lyrics.line && lyricsInteractionMode === 'dictionary' && (
          renderDictionaryLyrics(lyrics.line, false)
        )}
      </div>

      {activeOverlayState && (
        <YomitanOverlay
          open={overlayTokens.length > 0}
          tokens={overlayTokens}
          selectedTokenIndex={activeOverlayState.tokenIndex}
          dictionaries={installedDictionaries}
          enabledDictionaryMap={enabledDictionaryMap}
          onSelectToken={(tokenIndex) => {
            setOverlayState((current) => (
              current && current.sessionKey === overlaySessionKey
                ? { ...current, tokenIndex }
                : current
            ));
          }}
          onClose={() => setOverlayState(null)}
        />
      )}
    </div>
  );
}
