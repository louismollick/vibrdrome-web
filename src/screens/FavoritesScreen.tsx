import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSubsonicClient } from '../api/SubsonicClient';
import { usePlayerStore } from '../stores/playerStore';
import { useOfflineLibrary } from '../hooks/useOfflineLibrary';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import type { Artist, Album, Song } from '../types/subsonic';
import { Header, CoverArt, AlbumCard, SongRow, LoadingSpinner, StateMessage } from '../components/common';

type Tab = 'artists' | 'albums' | 'songs';

export default function FavoritesScreen() {
  const navigate = useNavigate();
  const playSongs = usePlayerStore((s) => s.playSongs);
  const offlineLibrary = useOfflineLibrary();
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<Tab>('artists');
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOnline) return;

    const load = async () => {
      try {
        const client = getSubsonicClient();
        const data = await client.getStarred2();
        setArtists(data.artist ?? []);
        setAlbums(data.album ?? []);
        setSongs(data.song ?? []);
      } catch (err) {
        console.error('Failed to load favorites:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isOnline]);

  const displayArtists = isOnline ? artists : [];
  const displayAlbums = isOnline ? albums : offlineLibrary.albums.filter((album) => !!album.starred);
  const displaySongs = isOnline ? songs : offlineLibrary.songs.filter((song) => !!song.starred);
  const displayLoading = isOnline ? loading : false;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'artists', label: 'Artists' },
    { key: 'albums', label: 'Albums' },
    { key: 'songs', label: 'Songs' },
  ];

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <Header title="Favorites" showBack />

      {/* Tab bar */}
      <div className="flex border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2.5 text-center text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? 'border-b-2 border-accent text-accent'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {displayLoading ? (
        <LoadingSpinner />
      ) : (
        <div className="flex-1 overflow-y-auto pb-24">
          {/* Artists tab */}
          {activeTab === 'artists' && (
            <div className="px-4 pt-2">
              {!isOnline && (
                <StateMessage
                  title="Favorite artists unavailable offline"
                  body="Artist favorites are not stored locally yet."
                />
              )}

              {isOnline && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {displayArtists.map((artist) => (
                  <button
                    key={artist.id}
                    onClick={() => navigate(`/artist/${artist.id}`)}
                    className="group flex flex-col items-center gap-2 text-center"
                  >
                    <CoverArt
                      coverArt={artist.coverArt}
                      className="w-full !rounded-full transition-transform duration-200 group-hover:scale-[1.03]"
                    />
                    <div className="min-w-0 w-full px-1">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {artist.name}
                      </p>
                      {artist.albumCount !== undefined && (
                        <p className="text-xs text-text-muted">
                          {artist.albumCount} {artist.albumCount === 1 ? 'album' : 'albums'}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
              )}
              {isOnline && displayArtists.length === 0 && (
                <div className="flex flex-col items-center py-16">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="mb-3 h-10 w-10 text-text-muted/40">
                    <path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z" clipRule="evenodd" />
                  </svg>
                  <p className="text-sm text-text-muted">No favorite artists yet</p>
                  <p className="mt-1 text-xs text-text-muted/70">Star artists to see them here</p>
                </div>
              )}
            </div>
          )}

          {/* Albums tab */}
          {activeTab === 'albums' && (
            <div className="px-4 pt-4">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
                {displayAlbums.map((album) => (
                  <AlbumCard key={album.id} album={album} />
                ))}
              </div>
              {displayAlbums.length === 0 && (
                <StateMessage
                  title={isOnline ? 'No favorite albums yet' : 'Favorites unavailable offline'}
                  body={isOnline ? 'Star albums to see them here' : 'No downloaded album favorites are available on this device.'}
                />
              )}
            </div>
          )}

          {/* Songs tab */}
          {activeTab === 'songs' && (
            <div className="px-1">
              {displaySongs.map((song, i) => (
                <SongRow
                  key={song.id}
                  song={song}
                  index={i}
                  showAlbum
                  onPlay={() => playSongs(displaySongs, i)}
                />
              ))}
              {displaySongs.length === 0 && (
                <StateMessage
                  title={isOnline ? 'No favorite songs yet' : 'Favorites unavailable offline'}
                  body={isOnline ? 'Star songs to see them here' : 'No downloaded song favorites are available on this device.'}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
