import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Song } from '../../types/subsonic';
import { getSubsonicClient } from '../../api/SubsonicClient';
import { getDownloadManager } from '../../audio/DownloadManager';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useAuthStore } from '../../stores/authStore';
import { useDownloadStore } from '../../stores/downloadStore';
import { usePlayerStore } from '../../stores/playerStore';
import { buildCacheId } from '../../utils/downloadCache';
import { getOfflineMessage } from '../../utils/offlineCapability';
import ContextMenu from './ContextMenu';

interface SongRowProps {
  song: Song;
  index?: number;
  showTrackNumber?: boolean;
  showAlbum?: boolean;
  onPlay?: () => void;
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null) return '--:--';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function SongRow({
  song,
  index,
  showTrackNumber = false,
  showAlbum = false,
  onPlay,
}: SongRowProps) {
  const navigate = useNavigate();
  const [starred, setStarred] = useState(!!song.starred);
  const isOnline = useOnlineStatus();
  const activeServerId = useAuthStore((s) => s.activeServerId);
  const isCachedForServer = useDownloadStore((s) => s.isCachedForServer);
  const isQueuedForServer = useDownloadStore((s) => s.isQueuedForServer);
  const removeFromCache = useDownloadStore((s) => s.removeFromCache);

  const displayNumber = showTrackNumber ? song.track : index !== undefined ? index + 1 : undefined;
  const favoritesOfflineMessage = getOfflineMessage('favoritesMutation');
  const artistRadioOfflineMessage = getOfflineMessage('artistRadio');
  const isDownloaded = !!activeServerId && isCachedForServer(activeServerId, song.id);
  const isQueued = !!activeServerId && isQueuedForServer(activeServerId, song.id);

  const handleStarToggle = async () => {
    if (!isOnline) return;
    const client = getSubsonicClient();
    try {
      if (starred) {
        await client.unstar(song.id);
      } else {
        await client.star(song.id);
      }
      setStarred(!starred);
    } catch {
      // silently fail
    }
  };

  const menuItems = [
    {
      label: 'Play Next',
      onClick: () => {
        usePlayerStore.getState().playNext(song);
      },
    },
    {
      label: 'Add to Queue',
      onClick: () => {
        usePlayerStore.getState().addToQueue(song);
      },
    },
    {
      label: isDownloaded ? 'Remove download' : isQueued ? 'Downloading...' : 'Download',
      onClick: () => {
        if (!activeServerId) return;
        if (isDownloaded) {
          void removeFromCache(buildCacheId(activeServerId, song.id));
          return;
        }
        if (!isOnline || isQueued) return;
        getDownloadManager().queueSongs([song], song.albumId);
      },
      disabled: isDownloaded ? !activeServerId : !activeServerId || !isOnline || isQueued,
    },
    {
      label: 'Go to Album',
      onClick: () => {
        if (song.albumId) navigate(`/album/${song.albumId}`);
      },
    },
    {
      label: 'Go to Artist',
      onClick: () => {
        if (song.artistId) navigate(`/artist/${song.artistId}`);
      },
    },
    {
      label: starred ? 'Unstar' : 'Star',
      onClick: handleStarToggle,
      disabled: !isOnline,
    },
    {
      label: !isOnline ? artistRadioOfflineMessage.title : 'Song Radio',
      onClick: async () => {
        if (!isOnline) return;
        try {
          const client = getSubsonicClient();
          const result = await client.getSimilarSongs2(song.id, 50);
          if (result && result.length > 0) {
            usePlayerStore.getState().playSongs(result);
          }
        } catch {
          // silently fail
        }
      },
      disabled: !isOnline,
    },
  ];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onPlay) { e.preventDefault(); onPlay(); } }}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-bg-tertiary"
    >
      {/* Track number / index */}
      {displayNumber !== undefined && (
        <span className="w-7 shrink-0 text-right text-sm text-text-muted">
          {displayNumber}
        </span>
      )}

      {/* Song info */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary">
          {song.title}
        </p>
        <p className="truncate text-xs text-text-secondary">
          {song.artist}
          {showAlbum && song.album ? ` \u00B7 ${song.album}` : ''}
        </p>
      </div>

      {(isDownloaded || isQueued) && (
        <span
          className={`flex shrink-0 items-center justify-center ${
            isDownloaded ? 'text-accent' : 'animate-pulse text-text-muted'
          }`}
          aria-label={isDownloaded ? 'Available offline' : 'Downloading'}
          title={isDownloaded ? 'Available offline' : 'Downloading'}
        >
          {isDownloaded ? (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path fillRule="evenodd" d="M19.916 4.626a.75.75 0 01.208 1.04l-9 13.5a.75.75 0 01-1.154.114l-6-6a.75.75 0 011.06-1.06l5.353 5.353 8.493-12.739a.75.75 0 011.04-.208z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
          )}
        </span>
      )}

      {/* Duration */}
      <span className="shrink-0 text-xs text-text-muted">
        {formatDuration(song.duration)}
      </span>

      {/* Context menu */}
      <ContextMenu
        items={menuItems}
        trigger={
          <button
            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted opacity-0 transition-all hover:bg-bg-secondary hover:text-text-primary group-hover:opacity-100"
            aria-label="More options"
            title={!isOnline ? `${favoritesOfflineMessage.title} ${favoritesOfflineMessage.body}` : undefined}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-5 w-5"
            >
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
        }
      />
    </div>
  );
}
