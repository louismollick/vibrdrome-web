import type { ServerConfig } from '../types/subsonic';

export const OFFLINE_AUDIO_PATH = '/__offline_audio__';
export const AUDIO_CACHE_NAME = 'vibrdrome-audio-v1';
export const ART_CACHE_NAME = 'vibrdrome-art-v1';
export const REQUIRED_COVER_ART_SIZES = [76, 150, 300, 512];

function normalizeServerOrigin(serverUrl: string): string {
  return new URL(serverUrl).origin;
}

export function buildCacheId(serverId: string, songId: string): string {
  return `${serverId}:${songId}`;
}

export function buildAudioCacheKey(serverUrl: string, username: string, songId: string): string {
  const params = new URLSearchParams({
    server: normalizeServerOrigin(serverUrl),
    user: username,
    id: songId,
  });
  return `${window.location.origin}${OFFLINE_AUDIO_PATH}?${params.toString()}`;
}

export function buildAudioCacheKeyForServer(server: ServerConfig, songId: string): string {
  return buildAudioCacheKey(server.url, server.username, songId);
}

export function buildCoverArtCacheKey(coverArtUrl: string): string {
  const url = new URL(coverArtUrl);
  const coverArtId = url.searchParams.get('id');

  if (!coverArtId) return coverArtUrl;

  const params = new URLSearchParams({
    server: url.origin,
    id: coverArtId,
  });

  const username = url.searchParams.get('u');
  const size = url.searchParams.get('size');

  if (username) params.set('user', username);
  if (size) params.set('size', size);

  return `${window.location.origin}/__offline_cover_art__?${params.toString()}`;
}
