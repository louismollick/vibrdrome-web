import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSubsonicClient } from '../api/SubsonicClient';
import { getNavidromeClient } from '../api/NavidromeClient';
import { useAuthStore } from '../stores/authStore';
import { usePlayerStore } from '../stores/playerStore';
import { useMusicFolderStore } from '../stores/musicFolderStore';
import { useUIStore } from '../stores/uiStore';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useMultiSelect } from '../hooks/useMultiSelect';
import type { Genre, Song } from '../types/subsonic';
import type { NavidromeMediaFile, NavidromeTag, SongsPageSong } from '../types/navidrome';
import { Header, SongRow, LoadingSpinner, StateMessage } from '../components/common';
import BatchActionBar from '../components/common/BatchActionBar';
import { useOfflineLibrary } from '../hooks/useOfflineLibrary';
import { getNavidromeLyricsState } from '../utils/navidromeLyrics';
import {
  buildNavidromeTagFilterOptions,
  filterNavidromeSongs,
  normalizeNavidromeTagName,
  type NavidromeCustomTagFilter,
} from '../utils/navidromeTagFilters';

const PAGE_SIZE = 100;
const NAVIDROME_PAGE_SIZE = 250;
const NAVIDROME_UNAVAILABLE_NOTICE = 'Navidrome tag filters unavailable for this server. Showing standard Songs view.';

type SongsSourceMode = 'standard' | 'native' | 'bootstrapping-native';
type LyricsFilter = 'all' | 'synced' | 'unsynced' | 'none';

function adaptNavidromeSong(song: NavidromeMediaFile): SongsPageSong {
  return {
    id: String(song.id),
    parent: song.parent !== undefined ? String(song.parent) : undefined,
    title: song.title,
    album: song.album,
    artist: song.artist,
    albumId: song.albumId !== undefined ? String(song.albumId) : undefined,
    artistId: song.artistId !== undefined ? String(song.artistId) : undefined,
    track: song.track ?? song.trackNumber,
    year: song.year,
    genre: song.genre,
    coverArt: song.coverArt,
    size: song.size,
    contentType: song.contentType,
    suffix: song.suffix,
    duration: song.duration,
    bitRate: song.bitRate,
    path: song.path,
    discNumber: song.discNumber,
    created: song.createdAt ?? song.created,
    starred: song.starred,
    navidromeTags: Object.fromEntries(
      Object.entries(song.tags ?? {})
        .map(([tagName, values]) => [
          normalizeNavidromeTagName(tagName),
          values.filter((value) => value.trim().length > 0),
        ])
        .filter(([, values]) => values.length > 0),
    ),
    navidromeLyricsState: getNavidromeLyricsState(song.lyrics),
  };
}

function parseLibraryId(activeFolderId: string | null) {
  if (activeFolderId === null) return undefined;
  const libraryId = Number(activeFolderId);
  return Number.isFinite(libraryId) ? libraryId : undefined;
}

export default function SongsScreen() {
  const playSongs = usePlayerStore((s) => s.playSongs);
  const activeFolderId = useMusicFolderStore((s) => s.activeFolderId);
  const activeServerId = useAuthStore((s) => s.activeServerId);
  const activeServer = useAuthStore((s) => s.servers.find((server) => server.id === activeServerId) ?? null);
  const navidromeTagFiltersEnabled = useUIStore((s) => s.navidromeTagFiltersEnabled);
  const isOnline = useOnlineStatus();
  const offlineLibrary = useOfflineLibrary();

  const [allSongs, setAllSongs] = useState<SongsPageSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [sourceMode, setSourceMode] = useState<SongsSourceMode>('standard');

  const [genres, setGenres] = useState<Genre[]>([]);
  const [filterGenre, setFilterGenre] = useState('');
  const [filterYear, setFilterYear] = useState('');
  const [filterArtist, setFilterArtist] = useState('');
  const [filterLyricsState, setFilterLyricsState] = useState<LyricsFilter>('all');
  const [customTagFilters, setCustomTagFilters] = useState<NavidromeCustomTagFilter[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [usingOfflineData, setUsingOfflineData] = useState(false);
  const [nativeUnavailableNotice, setNativeUnavailableNotice] = useState<string | null>(null);
  const [nativeTags, setNativeTags] = useState<NavidromeTag[]>([]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const standardLoadIdRef = useRef(0);
  const nativeLoadIdRef = useRef(0);

  const libraryId = parseLibraryId(activeFolderId);
  const nativeRequested = navidromeTagFiltersEnabled && !!activeServer && isOnline;
  const nativeMode = sourceMode === 'native';
  const nativeTagOptions = useMemo(() => buildNavidromeTagFilterOptions(nativeTags), [nativeTags]);
  const shouldRunStandardMode = sourceMode === 'standard' && (!nativeRequested || nativeUnavailableNotice !== null);

  useEffect(() => {
    if (!shouldRunStandardMode) return;

    getSubsonicClient().getGenres().then((loadedGenres) => {
      setGenres(loadedGenres.sort((a, b) => a.value.localeCompare(b.value)));
    }).catch(() => {
      setGenres(offlineLibrary.genres);
    });
  }, [offlineLibrary.genres, shouldRunStandardMode]);

  const loadStandardSongs = useCallback(async (append = false) => {
    const loadId = ++standardLoadIdRef.current;

    if (append) setLoadingMore(true);
    else setLoading(true);

    try {
      const client = getSubsonicClient();
      const data = await client.getRandomSongs(PAGE_SIZE, filterGenre || undefined, activeFolderId ?? undefined);

      if (loadId !== standardLoadIdRef.current) return;

      setUsingOfflineData(false);
      if (append) {
        setAllSongs((prev) => {
          const ids = new Set(prev.map((song) => song.id));
          const newSongs = data.filter((song) => !ids.has(song.id));
          return [...prev, ...newSongs];
        });
      } else {
        setAllSongs(data);
      }

      setHasMore(data.length >= PAGE_SIZE);
    } catch (err) {
      console.error('Failed to load songs:', err);
      if (loadId !== standardLoadIdRef.current) return;
      setUsingOfflineData(true);
      setAllSongs(offlineLibrary.songs);
      setHasMore(false);
    } finally {
      if (loadId === standardLoadIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [activeFolderId, filterGenre, offlineLibrary.songs]);

  useEffect(() => {
    const loadId = ++nativeLoadIdRef.current;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset native-only filter state when data source changes
    setNativeTags([]);
    setCustomTagFilters([]);
    setFilterLyricsState('all');

    if (!nativeRequested || !activeServer) {
      setSourceMode('standard');
      setLoading(true);
      setLoadingMore(false);
      setAllSongs([]);
      setUsingOfflineData(false);
      if (isOnline || !navidromeTagFiltersEnabled) {
        setNativeUnavailableNotice(null);
      }
      return;
    }

    const client = getNavidromeClient();
    client.setConfig(activeServer);
    standardLoadIdRef.current += 1;

    setSourceMode('bootstrapping-native');
    setLoading(true);
    setLoadingMore(false);
    setAllSongs([]);
    setUsingOfflineData(false);
    setHasMore(false);
    setNativeUnavailableNotice(null);

    void (async () => {
      try {
        await client.login();

        const [firstPage, tags] = await Promise.all([
          client.getSongsPage({
            start: 0,
            end: NAVIDROME_PAGE_SIZE,
            sort: 'path',
            order: 'ASC',
            libraryId,
          }),
          client.getTags({ libraryId }),
        ]);

        if (loadId !== nativeLoadIdRef.current) return;

        const adaptedFirstPage = firstPage.map(adaptNavidromeSong);
        const totalCount = client.getLastSongsPageTotalCount();

        setSourceMode('native');
        setAllSongs(adaptedFirstPage);
        setNativeTags(tags);
        setLoading(false);
        setLoadingMore(false);

        const fullyLoaded = (totalCount !== null && adaptedFirstPage.length >= totalCount)
          || firstPage.length < NAVIDROME_PAGE_SIZE;

        if (fullyLoaded) {
          return;
        }

        setLoadingMore(true);

        let start = NAVIDROME_PAGE_SIZE;
        while (loadId === nativeLoadIdRef.current) {
          const page = await client.getSongsPage({
            start,
            end: start + NAVIDROME_PAGE_SIZE,
            sort: 'path',
            order: 'ASC',
            libraryId,
          });

          if (loadId !== nativeLoadIdRef.current) return;

          if (page.length === 0) break;

          const adaptedPage = page.map(adaptNavidromeSong);
          setAllSongs((prev) => {
            const ids = new Set(prev.map((song) => song.id));
            const nextSongs = adaptedPage.filter((song) => !ids.has(song.id));
            return nextSongs.length > 0 ? [...prev, ...nextSongs] : prev;
          });

          start += NAVIDROME_PAGE_SIZE;
          if ((totalCount !== null && start >= totalCount) || page.length < NAVIDROME_PAGE_SIZE) {
            break;
          }
        }

        if (loadId === nativeLoadIdRef.current) {
          setLoadingMore(false);
        }
      } catch (err) {
        console.error('Failed to load Navidrome songs:', err);
        if (loadId !== nativeLoadIdRef.current) return;
        setSourceMode('standard');
        setLoading(true);
        setLoadingMore(false);
        setNativeUnavailableNotice(NAVIDROME_UNAVAILABLE_NOTICE);
        setNativeTags([]);
      }
    })();
  }, [activeServer, isOnline, libraryId, nativeRequested, navidromeTagFiltersEnabled]);

  useEffect(() => {
    if (!shouldRunStandardMode) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset pagination when standard source parameters change
    setHasMore(true);
    loadStandardSongs(false);
  }, [loadStandardSongs, shouldRunStandardMode]);

  const filteredSongs = useMemo(() => {
    if (nativeMode) {
      return filterNavidromeSongs(allSongs, {
        artist: filterArtist,
        genre: filterGenre,
        year: filterYear,
        lyricsState: filterLyricsState,
        customTags: customTagFilters,
      });
    }

    let filtered = allSongs;

    if (filterArtist) {
      const query = filterArtist.toLowerCase();
      filtered = filtered.filter((song) => song.artist?.toLowerCase().includes(query));
    }

    if (filterYear) {
      const year = Number(filterYear);
      if (!Number.isNaN(year)) {
        filtered = filtered.filter((song) => song.year === year);
      }
    }

    return filtered;
  }, [allSongs, customTagFilters, filterArtist, filterGenre, filterLyricsState, filterYear, nativeMode]);

  useEffect(() => {
    if (!sentinelRef.current || !hasMore || loading || loadingMore || sourceMode !== 'standard') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          loadStandardSongs(true);
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadStandardSongs, loading, loadingMore, sourceMode]);

  const { selectionMode, selectedIds, selectedCount, toggle, clearAll, enterSelectionMode, selectAll, isSelected } = useMultiSelect<string>();

  const activeFilterCount = Number(Boolean(filterGenre))
    + Number(Boolean(filterArtist))
    + Number(Boolean(filterYear))
    + Number(filterLyricsState !== 'all')
    + customTagFilters.length;

  const clearFilters = () => {
    setFilterGenre('');
    setFilterArtist('');
    setFilterYear('');
    setFilterLyricsState('all');
    setCustomTagFilters([]);
  };

  const handleShuffleAll = () => {
    if (filteredSongs.length === 0) return;
    const shuffled = [...filteredSongs].sort(() => Math.random() - 0.5);
    playSongs(shuffled, 0);
  };

  const handlePlayFrom = (index: number) => {
    playSongs(filteredSongs as Song[], index);
  };

  const addCustomTagFilter = () => {
    const usedNames = new Set(customTagFilters.map((filter) => normalizeNavidromeTagName(filter.tagName)));
    const nextTagName = nativeTagOptions.customTagNames.find((tagName) => !usedNames.has(tagName));
    if (!nextTagName) return;

    const firstValue = nativeTagOptions.valuesByTagName[nextTagName]?.[0];
    if (!firstValue) return;

    setCustomTagFilters((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        tagName: nextTagName,
        tagValue: firstValue,
      },
    ]);
  };

  const updateCustomTagFilter = (id: string, updates: Partial<NavidromeCustomTagFilter>) => {
    setCustomTagFilters((prev) => prev.map((filter) => {
      if (filter.id !== id) return filter;

      const nextTagName = updates.tagName ?? filter.tagName;
      const values = nativeTagOptions.valuesByTagName[normalizeNavidromeTagName(nextTagName)] ?? [];
      const nextTagValue = updates.tagValue
        ?? (values.includes(filter.tagValue) ? filter.tagValue : values[0] ?? '');

      return {
        ...filter,
        ...updates,
        tagName: nextTagName,
        tagValue: nextTagValue,
      };
    }));
  };

  const removeCustomTagFilter = (id: string) => {
    setCustomTagFilters((prev) => prev.filter((filter) => filter.id !== id));
  };

  const availableGenres = nativeMode
    ? nativeTagOptions.genres
    : genres.map((genre) => genre.value);

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <Header title={`Songs${filteredSongs.length > 0 ? ` (${filteredSongs.length.toLocaleString()})` : ''}`} showBack />

      {nativeUnavailableNotice && (
        <div className="px-4 pb-3 text-xs text-text-muted">
          {nativeUnavailableNotice}
        </div>
      )}

      {usingOfflineData && (
        <div className="px-4 pb-3 text-xs text-text-muted">
          Showing downloaded songs from offline cache.
          {!isOnline && navidromeTagFiltersEnabled ? ' Navidrome tag filters require connection.' : ''}
        </div>
      )}

      <div className="flex items-center gap-3 px-4 pb-3">
        <button
          onClick={handleShuffleAll}
          disabled={loading || filteredSongs.length === 0}
          className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
          </svg>
          Shuffle All
        </button>

        {!nativeMode && (
          <button
            onClick={() => loadStandardSongs(true)}
            disabled={loading || loadingMore || usingOfflineData || sourceMode !== 'standard'}
            className="flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50"
          >
            Load More
          </button>
        )}

        <button
          onClick={() => setShowFilters((prev) => !prev)}
          className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
            showFilters || activeFilterCount > 0
              ? 'border-accent text-accent'
              : 'border-border text-text-primary hover:bg-bg-tertiary'
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path fillRule="evenodd" d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 01.628.74v2.288a2.25 2.25 0 01-.659 1.59l-4.682 4.683a2.25 2.25 0 00-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 018 18.25v-5.757a2.25 2.25 0 00-.659-1.591L2.659 6.22A2.25 2.25 0 012 4.629V2.34a.75.75 0 01.628-.74z" clipRule="evenodd" />
          </svg>
          Filters
        </button>

        <button
          onClick={() => {
            if (selectionMode) clearAll();
            else enterSelectionMode();
          }}
          className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
            selectionMode ? 'border-accent text-accent' : 'border-border text-text-primary hover:bg-bg-tertiary'
          }`}
        >
          {selectionMode ? 'Cancel' : 'Select'}
        </button>

        {selectionMode && filteredSongs.length > 0 && (
          <button
            onClick={() => selectAll(filteredSongs.map((song) => song.id))}
            className="text-xs text-accent hover:underline"
          >
            Select All
          </button>
        )}
      </div>

      {showFilters && (
        <div className="space-y-2 px-4 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={filterArtist}
              onChange={(e) => setFilterArtist(e.target.value)}
              placeholder="Filter by artist..."
              className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-primary placeholder-text-muted outline-none focus:border-accent"
            />
            <select
              value={filterGenre}
              onChange={(e) => setFilterGenre(e.target.value)}
              className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
            >
              <option value="">All Genres</option>
              {availableGenres.map((genre) => (
                <option key={genre} value={genre}>{genre}</option>
              ))}
            </select>
            <input
              type="number"
              value={filterYear}
              onChange={(e) => setFilterYear(e.target.value)}
              placeholder="Year"
              min={1900}
              max={2099}
              className="w-20 rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-primary placeholder-text-muted outline-none focus:border-accent"
            />
            {nativeMode && (
              <select
                aria-label="Lyrics state"
                value={filterLyricsState}
                onChange={(e) => setFilterLyricsState(e.target.value as LyricsFilter)}
                className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
              >
                <option value="all">All Lyrics</option>
                <option value="synced">Synced Lyrics</option>
                <option value="unsynced">Unsynced Lyrics</option>
                <option value="none">No Lyrics</option>
              </select>
            )}
            {activeFilterCount > 0 && (
              <button
                onClick={clearFilters}
                className="text-xs text-accent hover:underline"
              >
                Clear
              </button>
            )}
          </div>

          {nativeMode && (
            <div className="space-y-2">
              {customTagFilters.map((filter) => {
                const usedNames = new Set(
                  customTagFilters
                    .filter((item) => item.id !== filter.id)
                    .map((item) => normalizeNavidromeTagName(item.tagName)),
                );
                const normalizedTagName = normalizeNavidromeTagName(filter.tagName);
                const availableNames = nativeTagOptions.customTagNames.filter((tagName) =>
                  tagName === normalizedTagName || !usedNames.has(tagName),
                );
                const availableValues = nativeTagOptions.valuesByTagName[normalizedTagName] ?? [];

                return (
                  <div key={filter.id} className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Tag name"
                      value={normalizedTagName}
                      onChange={(e) => updateCustomTagFilter(filter.id, {
                        tagName: e.target.value,
                        tagValue: nativeTagOptions.valuesByTagName[e.target.value]?.[0] ?? '',
                      })}
                      className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
                    >
                      {availableNames.map((tagName) => (
                        <option key={tagName} value={tagName}>{tagName}</option>
                      ))}
                    </select>
                    <select
                      aria-label="Tag value"
                      value={filter.tagValue}
                      onChange={(e) => updateCustomTagFilter(filter.id, { tagValue: e.target.value })}
                      className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
                    >
                      {availableValues.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => removeCustomTagFilter(filter.id)}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-primary transition-colors hover:bg-bg-tertiary"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}

              <button
                onClick={addCustomTagFilter}
                disabled={nativeTagOptions.customTagNames.length === customTagFilters.length}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50"
              >
                Add Tag Filter
              </button>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : (
        <div className="flex-1 overflow-y-auto pb-24">
          <div className="mx-auto max-w-5xl px-1">
            {filteredSongs.map((song, index) => (
              <div key={`${song.id}-${index}`} className="flex items-center gap-0">
                {selectionMode && (
                  <button
                    onClick={() => toggle(song.id)}
                    className="flex h-10 w-8 shrink-0 items-center justify-center"
                  >
                    <div className={`h-4 w-4 rounded border-2 transition-colors ${
                      isSelected(song.id) ? 'border-accent bg-accent' : 'border-text-muted'
                    }`}>
                      {isSelected(song.id) && (
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="white" className="h-3 w-3">
                          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                  </button>
                )}
                <SongRow
                  song={song}
                  index={index}
                  showAlbum
                  onPlay={() => selectionMode ? toggle(song.id) : handlePlayFrom(index)}
                />
              </div>
            ))}

            {shouldRunStandardMode && hasMore && !usingOfflineData && (
              <div ref={sentinelRef} className="flex justify-center py-4">
                {loadingMore && (
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-bg-tertiary border-t-accent" />
                )}
              </div>
            )}

            {nativeMode && loadingMore && (
              <div className="py-4 text-center text-xs text-text-muted">
                Loading remaining library…
              </div>
            )}

            {filteredSongs.length === 0 && !loading && (
              <StateMessage
                title={usingOfflineData ? 'No downloaded songs available offline' : 'No songs found'}
                body={usingOfflineData ? 'Download songs while online to play them offline later.' : undefined}
              />
            )}
          </div>
        </div>
      )}

      {selectionMode && (
        <BatchActionBar
          selectedCount={selectedCount}
          songs={filteredSongs as Song[]}
          selectedIds={selectedIds}
          onClear={clearAll}
        />
      )}
    </div>
  );
}
