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
  buildLyricsTokenizationJobKey,
  clearLyricsTokenizationCache,
  ensureLyricsTokenization,
  getLyricsTokenizationSnapshot,
  subscribeToLyricsTokenization,
} from '../utils/lyricsTokenizationManager';
import {
  buildEnabledDictionaryMap,
  getInstalledDictionaries,
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

const lyricTextSizeClass = 'text-2xl md:text-4xl lg:text-5xl';

function getSyncedLineClass(index: number, currentIdx: number) {
  if (index === currentIdx) {
    return `origin-left scale-105 ${lyricTextSizeClass} font-bold text-accent`;
  }

  if (index < currentIdx) {
    return `${lyricTextSizeClass} font-medium text-text-muted`;
  }

  return `${lyricTextSizeClass} font-medium text-text-secondary`;
}

function renderPlainLine(line: LyricLine) {
  return line.value || '\u00A0';
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
      clearLyricsTokenizationCache();
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

    const jobKey = buildLyricsTokenizationJobKey(
      activeServerId,
      currentSong.id,
      dictionaryPreferenceFingerprint,
    );
    const syncSnapshot = () => {
      const snapshot = getLyricsTokenizationSnapshot(jobKey);
      setTokenizedLines(snapshot.tokenizedLines);
      setTokenizationProgress(snapshot.progress);
    };

    syncSnapshot();
    const unsubscribe = subscribeToLyricsTokenization(jobKey, syncSnapshot);

    void ensureLyricsTokenization({
      jobKey,
      serverId: activeServerId,
      songId: currentSong.id,
      lines: lyrics.line,
      priorityIndex: lyrics.synced ? dictionaryPriorityLineIndexRef.current : -1,
      preferencesFingerprint: dictionaryPreferenceFingerprint,
      enabledDictionaryMap,
    });

    return unsubscribe;
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
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 5v14l8-7-8-7z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 5v14l8-7-8-7z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 5v14" />
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
          viewBox="0 0 32 32"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          className="h-4 w-4"
        >
          <path d="M16 7S9 1 2 6v22c7-5 14 0 14 0s7-5 14 0V6c-7-5-14 1-14 1m0 0v21" />
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
            className={`inline rounded-sm px-1 underline [text-decoration-thickness:auto] underline-offset-[0.16em] [text-decoration-skip-ink:none] transition-colors ${
              selected
                ? 'bg-text-primary/12 text-text-primary decoration-text-primary'
                : 'decoration-accent/70 hover:text-accent hover:decoration-accent'
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
    <div className="space-y-7 py-4">
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
              synced ? getSyncedLineClass(index, currentLineIndex) : `${lyricTextSizeClass} text-text-primary`
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
              <p key={index} className={`${lyricTextSizeClass} text-text-primary`}>
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
