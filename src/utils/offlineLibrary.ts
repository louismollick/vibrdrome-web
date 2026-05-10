import type { Album, ArtistIndex, Genre, Song } from '../types/subsonic';
import type { CachedSong } from '../stores/downloadStore';

type OfflineAlbumRecord = Album & {
  latestCachedAt: number;
};

export interface OfflineLibrarySnapshot {
  songs: Song[];
  albums: Album[];
  artistIndexes: ArtistIndex[];
  artistGenres: Map<string, Set<string>>;
  genres: Genre[];
}

function firstLetter(value?: string): string {
  if (!value) return '#';
  const char = value.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(char) ? char : '#';
}

function cachedSongToSong(song: CachedSong): Song {
  return {
    id: song.songId,
    title: song.title,
    artist: song.artist,
    artistId: song.artistId,
    album: song.album,
    albumId: song.albumId,
    track: song.track,
    year: song.year,
    genre: song.genre,
    coverArt: song.coverArt,
    duration: song.duration,
    discNumber: song.discNumber,
    created: song.created,
    starred: song.starred,
  };
}

export function buildOfflineLibrary(cachedSongs: CachedSong[]): OfflineLibrarySnapshot {
  const songsById = new Map<string, Song>();
  const albumMap = new Map<string, OfflineAlbumRecord>();
  const albumSongIds = new Map<string, Set<string>>();
  const genreAlbums = new Map<string, Set<string>>();
  const artistMap = new Map<string, { id: string; name: string; coverArt?: string; albumIds: Set<string> }>();
  const artistGenres = new Map<string, Set<string>>();
  const genresMap = new Map<string, Genre>();

  for (const cached of cachedSongs) {
    const song = cachedSongToSong(cached);
    songsById.set(song.id, song);

    const albumId = song.albumId ?? `offline-album:${song.album ?? song.id}`;
    const albumName = song.album ?? 'Unknown Album';
    const artistName = song.artist ?? 'Unknown Artist';
    const album = albumMap.get(albumId);
    if (album) {
      album.songCount = (album.songCount ?? 0) + 1;
      album.latestCachedAt = Math.max(album.latestCachedAt, cached.cachedAt);
      album.year ??= song.year;
      album.genre ??= song.genre;
      album.coverArt ??= song.coverArt;
      album.artistId ??= song.artistId;
      album.created ??= song.created;
      if (song.starred) album.starred = song.starred;
      if (!album.song) album.song = [];
      album.song.push(song);
    } else {
      albumMap.set(albumId, {
        id: albumId,
        name: albumName,
        artist: artistName,
        artistId: song.artistId,
        coverArt: song.coverArt,
        songCount: 1,
        year: song.year,
        genre: song.genre,
        created: song.created,
        starred: song.starred,
        song: [song],
        latestCachedAt: cached.cachedAt,
      });
    }

    if (!albumSongIds.has(albumId)) albumSongIds.set(albumId, new Set());
    albumSongIds.get(albumId)!.add(song.id);

    const artistId = song.artistId ?? `offline-artist:${artistName}`;
    if (!artistMap.has(artistId)) {
      artistMap.set(artistId, {
        id: artistId,
        name: artistName,
        coverArt: song.coverArt,
        albumIds: new Set(song.albumId ? [song.albumId] : [albumId]),
      });
    } else {
      const artist = artistMap.get(artistId)!;
      artist.coverArt ??= song.coverArt;
      artist.albumIds.add(song.albumId ?? albumId);
    }

    if (song.genre) {
      const genreKey = song.genre.toLowerCase();
      const genre = genresMap.get(genreKey);
      if (genre) {
        genre.songCount = (genre.songCount ?? 0) + 1;
      } else {
        genresMap.set(genreKey, {
          value: song.genre,
          songCount: 1,
          albumCount: 0,
        });
      }

      if (!genreAlbums.has(genreKey)) genreAlbums.set(genreKey, new Set());
      genreAlbums.get(genreKey)!.add(song.albumId ?? albumId);

      if (!artistGenres.has(artistId)) artistGenres.set(artistId, new Set());
      artistGenres.get(artistId)!.add(genreKey);
    }
  }

  const songs = Array.from(songsById.values()).sort((a, b) => {
    const artistCompare = (a.artist ?? '').localeCompare(b.artist ?? '');
    if (artistCompare !== 0) return artistCompare;
    const albumCompare = (a.album ?? '').localeCompare(b.album ?? '');
    if (albumCompare !== 0) return albumCompare;
    return (a.track ?? 0) - (b.track ?? 0) || a.title.localeCompare(b.title);
  });

  const albums = Array.from(albumMap.values())
    .sort((a, b) => b.latestCachedAt - a.latestCachedAt || a.name.localeCompare(b.name))
    .map((album) => {
      delete (album as Partial<OfflineAlbumRecord>).latestCachedAt;
      return album;
    });

  for (const [genreKey, genre] of genresMap) {
    genre.albumCount = genreAlbums.get(genreKey)?.size ?? 0;
  }

  const genres = Array.from(genresMap.values()).sort((a, b) => a.value.localeCompare(b.value));

  const groupedArtists = new Map<string, NonNullable<ArtistIndex['artist']>>();
  for (const artist of Array.from(artistMap.values()).sort((a, b) => a.name.localeCompare(b.name))) {
    const letter = firstLetter(artist.name);
    if (!groupedArtists.has(letter)) groupedArtists.set(letter, []);
    groupedArtists.get(letter)!.push({
      id: artist.id,
      name: artist.name,
      coverArt: artist.coverArt,
      albumCount: artist.albumIds.size,
    });
  }

  const artistIndexes = Array.from(groupedArtists.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, artist]) => ({ name, artist }));

  return { songs, albums, artistIndexes, artistGenres, genres };
}

export function filterOfflineAlbums(
  albums: Album[],
  options: {
    type: string;
    genre?: string;
    fromYear?: number;
    toYear?: number;
  },
): Album[] {
  let filtered = [...albums];

  if (options.genre) {
    const genre = options.genre.toLowerCase();
    filtered = filtered.filter((album) => album.genre?.toLowerCase() === genre);
  }

  if (options.fromYear !== undefined) {
    filtered = filtered.filter((album) => (album.year ?? Number.MIN_SAFE_INTEGER) >= options.fromYear!);
  }

  if (options.toYear !== undefined) {
    filtered = filtered.filter((album) => (album.year ?? Number.MAX_SAFE_INTEGER) <= options.toYear!);
  }

  switch (options.type) {
    case 'alphabeticalByName':
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'alphabeticalByArtist':
      filtered.sort((a, b) => (a.artist ?? '').localeCompare(b.artist ?? '') || a.name.localeCompare(b.name));
      break;
    case 'byYear':
      filtered.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.name.localeCompare(b.name));
      break;
    case 'starred':
      filtered = filtered.filter((album) => !!album.starred);
      filtered.sort((a, b) => (b.starred ?? '').localeCompare(a.starred ?? '') || a.name.localeCompare(b.name));
      break;
    case 'random':
      filtered.sort(() => Math.random() - 0.5);
      break;
    default:
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }

  return filtered;
}
