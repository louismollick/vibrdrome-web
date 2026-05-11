export type OfflineFeatureId =
  | 'artistRadio'
  | 'favoritesMutation'
  | 'folders'
  | 'lyrics'
  | 'playlists'
  | 'radio'
  | 'randomAlbum'
  | 'randomMix'
  | 'search'
  | 'serverManager'
  | 'share'
  | 'visualizer';

interface OfflineMessage {
  title: string;
  body: string;
}

interface OfflineRouteTitleRule {
  patterns: string[];
  title: string;
}

interface OfflineRouteRule {
  patterns: string[];
  supported: boolean;
  message: OfflineMessage;
}

const OFFLINE_ROUTE_RULES: OfflineRouteRule[] = [
  {
    patterns: ['/', '/albums', '/album/:albumId', '/artists', '/artist/:artistId', '/songs', '/genres', '/favorites', '/search', '/settings', '/downloads', '/now-playing', '/queue', '/lyrics', '/eq'],
    supported: true,
    message: {
      title: 'Offline mode',
      body: 'Showing locally available content when possible.',
    },
  },
  {
    patterns: ['/playlists', '/playlist/:playlistId', '/playlist/edit/:playlistId?', '/smart-playlists'],
    supported: false,
    message: {
      title: 'Playlists are unavailable offline',
      body: 'Reconnect to load playlist data. This screen was not cached for offline use.',
    },
  },
  {
    patterns: ['/folders', '/folder/:folderId'],
    supported: false,
    message: {
      title: 'Folders are unavailable offline',
      body: 'Reconnect to load music folders. This screen was not cached for offline use.',
    },
  },
  {
    patterns: ['/generations', '/settings/servers', '/share'],
    supported: false,
    message: {
      title: 'This screen is unavailable offline',
      body: 'Reconnect once to load it. This screen was not cached for offline use.',
    },
  },
  {
    patterns: ['/radio', '/radio/search', '/radio/add'],
    supported: false,
    message: {
      title: 'Radio is unavailable offline',
      body: 'Radio features need a live connection and are not supported offline.',
    },
  },
  {
    patterns: ['/visualizer'],
    supported: false,
    message: {
      title: 'Visualizer is unavailable offline',
      body: 'Reconnect to load the visualizer modules. This feature is not supported offline yet.',
    },
  },
];

const OFFLINE_FEATURE_MESSAGES: Record<OfflineFeatureId, OfflineMessage> = {
  artistRadio: {
    title: 'Artist radio is unavailable offline',
    body: 'Reconnect to build a radio mix from the server.',
  },
  favoritesMutation: {
    title: 'Favorites can’t be updated offline',
    body: 'Reconnect to star or unstar songs and albums.',
  },
  folders: {
    title: 'Folders are unavailable offline',
    body: 'Reconnect to browse server-backed music folders.',
  },
  lyrics: {
    title: 'Lyrics unavailable offline',
    body: 'Lyrics only work offline if they were loaded earlier in this session.',
  },
  playlists: {
    title: 'Playlists are unavailable offline',
    body: 'Reconnect to load playlists and playlist editing screens.',
  },
  radio: {
    title: 'Radio is unavailable offline',
    body: 'Reconnect to use internet radio and station discovery.',
  },
  randomAlbum: {
    title: 'No downloaded albums available offline',
    body: 'Download more music or reconnect to pick a random album from the server.',
  },
  randomMix: {
    title: 'No downloaded songs available offline',
    body: 'Download more music or reconnect to build a random mix from the server.',
  },
  search: {
    title: 'Search is limited offline',
    body: 'Only downloaded artists, albums, and songs can be searched offline.',
  },
  serverManager: {
    title: 'Server management is unavailable offline',
    body: 'Reconnect to edit server settings.',
  },
  share: {
    title: 'Sharing is unavailable offline',
    body: 'Reconnect to share links that depend on the server.',
  },
  visualizer: {
    title: 'Visualizer is unavailable offline',
    body: 'Reconnect to load the visualizer modules.',
  },
};

const OFFLINE_ROUTE_TITLES: OfflineRouteTitleRule[] = [
  { patterns: ['/generations'], title: 'Generations' },
  { patterns: ['/folders'], title: 'Folders' },
  { patterns: ['/folder/:folderId'], title: 'Folder' },
  { patterns: ['/playlists'], title: 'Playlists' },
  { patterns: ['/playlist/:playlistId'], title: 'Playlist' },
  { patterns: ['/playlist/edit/:playlistId?'], title: 'Edit Playlist' },
  { patterns: ['/smart-playlists'], title: 'Smart Playlists' },
  { patterns: ['/radio'], title: 'Radio' },
  { patterns: ['/radio/search'], title: 'Search Stations' },
  { patterns: ['/radio/add'], title: 'Add Station' },
  { patterns: ['/settings/servers'], title: 'Manage Servers' },
  { patterns: ['/share'], title: 'Shared Link' },
  { patterns: ['/visualizer'], title: 'Visualizer' },
];

function stripQueryAndHash(pathname: string) {
  return pathname.split('?')[0].split('#')[0];
}

function matchesPattern(pathname: string, pattern: string) {
  const normalizedPath = stripQueryAndHash(pathname).replace(/\/+$/, '') || '/';
  const normalizedPattern = pattern.replace(/\/+$/, '') || '/';

  if (normalizedPath === normalizedPattern) return true;

  const pathParts = normalizedPath.split('/').filter(Boolean);
  const patternParts = normalizedPattern.split('/').filter(Boolean);

  if (patternParts.length === 0) return pathParts.length === 0;

  const minPatternLength = patternParts.filter((part) => !part.endsWith('?')).length;
  if (pathParts.length < minPatternLength || pathParts.length > patternParts.length) return false;

  return patternParts.every((part, index) => {
    if (part.endsWith('?') && pathParts[index] === undefined) return true;
    if (part.startsWith(':')) {
      return part.endsWith('?') ? true : pathParts[index].length > 0;
    }
    return part === pathParts[index];
  });
}

function getOfflineRouteRule(pathname: string) {
  return OFFLINE_ROUTE_RULES.find((rule) => rule.patterns.some((pattern) => matchesPattern(pathname, pattern)));
}

export function isOfflineSupportedRoute(pathname: string) {
  return getOfflineRouteRule(pathname)?.supported ?? false;
}

export function getOfflineRouteTitle(pathname: string) {
  return OFFLINE_ROUTE_TITLES.find((rule) => rule.patterns.some((pattern) => matchesPattern(pathname, pattern)))?.title ?? 'Unavailable Offline';
}

export function isOfflineUnsupportedFeature(id: OfflineFeatureId) {
  return id in OFFLINE_FEATURE_MESSAGES;
}

export function getOfflineMessage(target: string): OfflineMessage {
  const featureMessage = OFFLINE_FEATURE_MESSAGES[target as OfflineFeatureId];
  if (featureMessage) return featureMessage;
  return getOfflineRouteRule(target)?.message ?? {
    title: 'This screen is unavailable offline',
    body: 'Reconnect once so the missing screen bundle can be cached, then try again.',
  };
}
