import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueSongs = vi.fn();
const removeFromCache = vi.fn(async () => {});

let authState = {
  activeServerId: 'server-1',
  servers: [
    {
      id: 'server-1',
      name: 'Primary',
      url: 'https://music.example.com',
      username: 'alice',
      password: 'secret',
    },
  ],
};

let uiState = {
  libraryAutoSyncEnabled: true,
};

type MockCachedSong = {
  cacheId: string;
  songId: string;
};

type MockDownloadState = {
  setLibrarySyncing: ReturnType<typeof vi.fn>;
  setLibrarySyncStatus: ReturnType<typeof vi.fn>;
  getCachedSongsForServer: ReturnType<typeof vi.fn<() => MockCachedSong[]>>;
  removeFromCache: typeof removeFromCache;
};

let downloadState: MockDownloadState = {
  setLibrarySyncing: vi.fn(),
  setLibrarySyncStatus: vi.fn(),
  getCachedSongsForServer: vi.fn(() => []),
  removeFromCache,
};

const clientMock = {
  setConfig: vi.fn(),
  getAlbumList2: vi.fn(),
  getAlbum: vi.fn(),
};

vi.mock('./DownloadManager', () => ({
  getDownloadManager: () => ({
    queueSongs,
  }),
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: {
    getState: () => authState,
  },
}));

vi.mock('../stores/uiStore', () => ({
  useUIStore: {
    getState: () => uiState,
  },
}));

vi.mock('../stores/downloadStore', () => ({
  useDownloadStore: {
    getState: () => downloadState,
  },
}));

vi.mock('../api/SubsonicClient', () => ({
  default: vi.fn(function MockSubsonicClient() {
    return clientMock;
  }),
}));

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();

  authState = {
    activeServerId: 'server-1',
    servers: [
      {
        id: 'server-1',
        name: 'Primary',
        url: 'https://music.example.com',
        username: 'alice',
        password: 'secret',
      },
    ],
  };

  uiState = {
    libraryAutoSyncEnabled: true,
  };

  downloadState = {
    setLibrarySyncing: vi.fn(),
    setLibrarySyncStatus: vi.fn(),
    getCachedSongsForServer: vi.fn(() => []),
    removeFromCache,
  };

  clientMock.getAlbumList2.mockResolvedValueOnce([{ id: 'album-1' }]).mockResolvedValueOnce([]);
  clientMock.getAlbum.mockResolvedValue({
    id: 'album-1',
    song: [{ id: 'song-1', title: 'Song 1' }],
  });
});

describe('LibrarySyncManager', () => {
  it('does nothing when library auto sync is disabled', async () => {
    uiState.libraryAutoSyncEnabled = false;
    vi.resetModules();
    const { getLibrarySyncManager } = await import('./LibrarySyncManager');

    getLibrarySyncManager().trigger('startup', { force: true });
    await flush();

    expect(queueSongs).not.toHaveBeenCalled();
    expect(removeFromCache).not.toHaveBeenCalled();
  });

  it('queues missing remote songs and removes stale local songs', async () => {
    downloadState.getCachedSongsForServer = vi.fn(() => [
      {
        cacheId: 'server-1:song-stale',
        songId: 'song-stale',
      },
    ]);

    vi.resetModules();
    const { getLibrarySyncManager } = await import('./LibrarySyncManager');

    getLibrarySyncManager().trigger('startup', { force: true });
    await flush();

    expect(queueSongs).toHaveBeenCalledWith([{ id: 'song-1', title: 'Song 1' }]);
    expect(removeFromCache).toHaveBeenCalledWith('server-1:song-stale');
  });
});
