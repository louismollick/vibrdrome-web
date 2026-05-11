import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSubsonicClient } from '../api/SubsonicClient';
import type { Genre } from '../types/subsonic';
import { Header, LoadingSpinner, StateMessage } from '../components/common';
import { useOfflineLibrary } from '../hooks/useOfflineLibrary';

export default function GenresScreen() {
  const navigate = useNavigate();
  const [genres, setGenres] = useState<Genre[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingOfflineData, setUsingOfflineData] = useState(false);
  const offlineLibrary = useOfflineLibrary();

  useEffect(() => {
    const load = async () => {
      try {
        const client = getSubsonicClient();
        const data = await client.getGenres();
        // Sort alphabetically by name
        data.sort((a, b) => a.value.localeCompare(b.value));
        setUsingOfflineData(false);
        setGenres(data);
      } catch (err) {
        console.error('Failed to load genres:', err);
        setUsingOfflineData(true);
        setGenres(offlineLibrary.genres);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [offlineLibrary.genres]);

  const handleGenreClick = (genre: Genre) => {
    const params = new URLSearchParams({
      type: 'byGenre',
      genre: genre.value,
      title: genre.value,
    });
    navigate(`/albums?${params.toString()}`);
  };

  if (loading) {
    return (
      <div className="flex h-full flex-col bg-bg-primary">
        <Header title="Genres" showBack />
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <Header title="Genres" showBack />

      {usingOfflineData && (
        <div className="px-4 pb-3 text-xs text-text-muted">
          Showing downloaded genres from offline cache.
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 pb-20">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {genres.map((genre) => (
            <button
              key={genre.value}
              onClick={() => handleGenreClick(genre)}
              className="flex flex-col items-start rounded-xl bg-bg-secondary p-4 text-left transition-colors hover:bg-bg-tertiary"
            >
              <span className="text-sm font-semibold text-text-primary">
                {genre.value}
              </span>
              <span className="mt-1 text-xs text-text-muted">
                {genre.albumCount ?? 0} albums
              </span>
            </button>
          ))}
        </div>

        {genres.length === 0 && (
          <StateMessage
            title={usingOfflineData ? 'No downloaded genres available offline' : 'No genres found'}
            body={usingOfflineData ? 'Download songs with genre metadata while online to browse them here later.' : undefined}
          />
        )}
      </div>
    </div>
  );
}
