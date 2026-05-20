import type { Song } from './subsonic';

export interface NavidromeTag {
  id: string;
  tagName: string;
  tagValue: string;
  songCount?: number;
  albumCount?: number;
}

export interface NavidromeLyricsEntry {
  lang?: string;
  synced?: boolean;
}

export interface NavidromeMediaFile {
  id: string | number;
  title: string;
  album?: string;
  artist?: string;
  albumId?: string | number;
  artistId?: string | number;
  coverArt?: string;
  genre?: string;
  year?: number;
  track?: number;
  trackNumber?: number;
  discNumber?: number;
  duration?: number;
  bitRate?: number;
  size?: number;
  contentType?: string;
  suffix?: string;
  path?: string;
  parent?: string | number;
  starred?: string;
  created?: string;
  createdAt?: string;
  updatedAt?: string;
  libraryId?: number;
  tags?: Record<string, string[]>;
  lyrics?: string;
  comment?: string;
  albumArtist?: string;
}

export type NavidromeLyricsState = 'synced' | 'unsynced' | 'none';

export type SongsPageSong = Song & {
  navidromeTags?: Record<string, string[]>;
  navidromeLyricsState?: NavidromeLyricsState;
};
