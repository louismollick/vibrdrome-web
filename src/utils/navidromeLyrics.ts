import type { NavidromeLyricsEntry, NavidromeLyricsState } from '../types/navidrome';

function isLyricsEntry(value: unknown): value is NavidromeLyricsEntry {
  return typeof value === 'object' && value !== null;
}

function extractEntries(parsed: unknown): NavidromeLyricsEntry[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(isLyricsEntry);
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const record = parsed as Record<string, unknown>;

  if (Array.isArray(record.lyrics)) {
    return record.lyrics.filter(isLyricsEntry);
  }

  if (Array.isArray(record.structuredLyrics)) {
    return record.structuredLyrics.filter(isLyricsEntry);
  }

  if (isLyricsEntry(parsed)) {
    return [parsed];
  }

  return [];
}

export function parseNavidromeLyricsEntries(lyrics?: string): NavidromeLyricsEntry[] {
  if (!lyrics?.trim()) return [];

  try {
    const parsed = JSON.parse(lyrics) as unknown;
    return extractEntries(parsed);
  } catch {
    return [];
  }
}

export function getNavidromeLyricsState(lyrics?: string): NavidromeLyricsState {
  const entries = parseNavidromeLyricsEntries(lyrics);

  if (entries.length === 0) return 'none';
  if (entries.some((entry) => entry.synced === true)) return 'synced';
  return 'unsynced';
}
