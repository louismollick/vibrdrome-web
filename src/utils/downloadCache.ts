import type { ServerConfig } from '../types/subsonic';

const OFFLINE_AUDIO_PATH = '/__offline_audio__';

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
