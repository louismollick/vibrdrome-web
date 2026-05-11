import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { getPlaybackManager } from '../audio/PlaybackManager';
import type { LyricLine } from '../types/subsonic';
import { Header, LoadingSpinner, StateMessage } from '../components/common';
import { useCurrentSongLyrics } from '../hooks/useCurrentSongLyrics';
import { getOfflineMessage } from '../utils/offlineCapability';

export default function LyricsScreen() {
  const currentSong = usePlayerStore((s) => s.currentSong);
  const positionMs = usePlayerStore((s) => s.positionMs);
  const { lyrics, status } = useCurrentSongLyrics(currentSong?.id);

  const currentLineRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastLineIdxRef = useRef(-1);
  const offlineLyricsMessage = getOfflineMessage('lyrics');

  // Auto-scroll only when the current line index changes
  useEffect(() => {
    if (currentLineRef.current && containerRef.current) {
      const el = currentLineRef.current;
      const container = containerRef.current;
      const idx = Number(el.dataset.lineIdx ?? '-1');
      if (idx !== lastLineIdxRef.current) {
        lastLineIdxRef.current = idx;
        const elTop = el.offsetTop - container.offsetTop;
        const elHeight = el.offsetHeight;
        const containerHeight = container.clientHeight;
        const targetScroll = elTop - containerHeight / 2 + elHeight / 2;
        container.scrollTo({ top: targetScroll, behavior: 'smooth' });
      }
    }
  }, [positionMs]);

  const getCurrentLineIndex = (lines: LyricLine[]): number => {
    let currentIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const start = lines[i].start ?? 0;
      if (start <= positionMs) {
        currentIdx = i;
      } else {
        break;
      }
    }
    return currentIdx;
  };

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <Header title="Lyrics" showBack />

      {/* Song info */}
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

        {status === 'ready' && lyrics && lyrics.synced && lyrics.line && (() => {
          const currentIdx = getCurrentLineIndex(lyrics.line!);
          return (
          <div className="space-y-3 py-4">
            {lyrics.line!.map((line, index) => {
              const isCurrent = index === currentIdx;
              return (
                <button
                  key={index}
                  ref={isCurrent ? currentLineRef : null}
                  data-line-idx={index}
                  onClick={() => {
                    if (line.start !== undefined) {
                      getPlaybackManager().seek(line.start);
                      usePlayerStore.getState().setPosition(line.start);
                    }
                  }}
                  className={`block w-full text-left transition-all duration-300 ${
                    isCurrent
                      ? 'scale-105 text-xl font-bold text-accent'
                      : index < currentIdx
                        ? 'text-lg font-medium text-text-muted'
                        : 'text-lg font-medium text-text-secondary'
                  }`}
                >
                  {line.value || '\u00A0'}
                </button>
              );
            })}
          </div>
          );
        })()}

        {status === 'ready' && lyrics && !lyrics.synced && lyrics.line && (
          <div className="space-y-2 py-4">
            {lyrics.line.map((line, index) => (
              <p key={index} className="text-base text-text-primary">
                {line.value || '\u00A0'}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
