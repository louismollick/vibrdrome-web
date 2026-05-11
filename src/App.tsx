import React, { Suspense, useEffect, Component, useRef } from 'react';
import type { ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { useUIStore } from './stores/uiStore';
import { usePlayerStore } from './stores/playerStore';
import LoadingSpinner from './components/common/LoadingSpinner';
import Sidebar from './components/common/Sidebar';
import { usePlayback } from './audio/usePlayback';
import { darkenHex } from './utils/color';
import { getOfflineMessage } from './utils/offlineCapability';
import CommandPalette from './components/common/CommandPalette';
import ShortcutsOverlay from './components/common/ShortcutsOverlay';
import RightPane from './components/player/RightPane';
import PopOutPlayer from './components/player/PopOutPlayer';
import MiniPlayer from './components/player/MiniPlayer';
import StateMessage from './components/common/StateMessage';
import { useDownloadStore } from './stores/downloadStore';
import { getLibrarySyncManager } from './audio/LibrarySyncManager';
import LibraryScreen from './screens/LibraryScreen';
import ArtistsScreen from './screens/ArtistsScreen';
import ArtistDetailScreen from './screens/ArtistDetailScreen';
import AlbumsListScreen from './screens/AlbumsListScreen';
import AlbumDetailScreen from './screens/AlbumDetailScreen';
import SongsScreen from './screens/SongsScreen';
import GenresScreen from './screens/GenresScreen';
import NowPlayingScreen from './screens/NowPlayingScreen';
import FavoritesScreen from './screens/FavoritesScreen';
import SearchScreen from './screens/SearchScreen';
import SettingsScreen from './screens/SettingsScreen';
import DownloadsScreen from './screens/DownloadsScreen';
import QueueScreen from './screens/QueueScreen';
import LyricsScreen from './screens/LyricsScreen';
import EQScreen from './screens/EQScreen';
import { useOnlineStatus } from './hooks/useOnlineStatus';

const CHUNK_RELOAD_GUARD_KEY = 'vibrdrome_chunk_reload_attempted';

function isChunkLoadError(error: Error): boolean {
  return error.message.includes('dynamically imported module') || error.message.includes('Failed to fetch');
}

// Error boundary for stale chunk errors after deploys
class ChunkErrorBoundary extends Component<{ children: ReactNode; pathname: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    if (isChunkLoadError(error)) {
      return { error };
    }
    throw error;
  }

  componentDidUpdate(prevProps: Readonly<{ children: ReactNode; pathname: string }>) {
    if (prevProps.pathname !== this.props.pathname && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      const offline = !navigator.onLine;
      const message = offline
        ? getOfflineMessage(this.props.pathname)
        : {
            title: 'A new version is available',
            body: 'Reload to update the app shell and screen bundles.',
          };

      return (
        <div className="flex min-h-dvh flex-col items-center justify-center bg-bg-primary px-4 text-center">
          <p className="mb-2 text-lg text-text-primary">{message.title}</p>
          <p className="mb-4 max-w-sm text-sm text-text-secondary">{message.body}</p>
          {!offline && (
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-accent px-6 py-3 font-semibold text-white hover:bg-accent-hover"
            >
              Reload
            </button>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

// Lazy-loaded screens with auto-retry on chunk failure
function lazyWithRetry(importFn: () => Promise<{ default: React.ComponentType }>) {
  return React.lazy(() =>
    importFn().catch((error: Error) => {
      if (isChunkLoadError(error) && navigator.onLine && !sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)) {
        sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
        window.location.reload();
        return new Promise(() => {});
      }
      throw error;
    })
  );
}

// Lazy-loaded screens
const LoginScreen = lazyWithRetry(() => import('./screens/LoginScreen'));
const GenerationsScreen = lazyWithRetry(() => import('./screens/GenerationsScreen'));
const FolderBrowserScreen = lazyWithRetry(() => import('./screens/FolderBrowserScreen'));
const FolderDetailScreen = lazyWithRetry(() => import('./screens/FolderDetailScreen'));
const PlaylistsScreen = lazyWithRetry(() => import('./screens/PlaylistsScreen'));
const PlaylistDetailScreen = lazyWithRetry(() => import('./screens/PlaylistDetailScreen'));
const PlaylistEditorScreen = lazyWithRetry(() => import('./screens/PlaylistEditorScreen'));
const SmartPlaylistScreen = lazyWithRetry(() => import('./screens/SmartPlaylistScreen'));
const RadioScreen = lazyWithRetry(() => import('./screens/RadioScreen'));
const StationSearchScreen = lazyWithRetry(() => import('./screens/StationSearchScreen'));
const AddStationScreen = lazyWithRetry(() => import('./screens/AddStationScreen'));
const ServerManagerScreen = lazyWithRetry(() => import('./screens/ServerManagerScreen'));
const VisualizerScreen = lazyWithRetry(() => import('./screens/VisualizerScreen'));
const ShareScreen = lazyWithRetry(() => import('./screens/ShareScreen'));

const HIDE_MINIPLAYER_ROUTES = ['/now-playing', '/visualizer', '/login'];
const HIDE_SIDEBAR_ROUTES = ['/login', '/now-playing', '/visualizer'];

function OfflineLazyRoute({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const isOnline = useOnlineStatus();

  if (!isOnline) {
    const message = getOfflineMessage(pathname);
    return (
      <div className="flex min-h-full items-center justify-center bg-bg-primary">
        <StateMessage title={message.title} body={message.body} />
      </div>
    );
  }

  return <>{children}</>;
}

export default function App() {
  const { isAuthenticated, activeServerId, loadFromStorage } = useAuthStore();
  const theme = useUIStore((s) => s.theme);
  const accentColor = useUIStore((s) => s.accentColor);
  const libraryAutoSyncEnabled = useUIStore((s) => s.libraryAutoSyncEnabled);
  const currentSong = usePlayerStore((s) => s.currentSong);
  const location = useLocation();
  const previousServerId = useRef<string | null>(null);

  // Initialize playback engine
  usePlayback();

  useEffect(() => {
    sessionStorage.removeItem(CHUNK_RELOAD_GUARD_KEY);
  }, []);

  // Load auth state and cached downloads on mount
  useEffect(() => {
    loadFromStorage();
    void useDownloadStore.getState().loadCachedSongs();
  }, [loadFromStorage]);

  useEffect(() => {
    const manager = getLibrarySyncManager();

    if (!isAuthenticated || !activeServerId) {
      manager.stop();
      previousServerId.current = activeServerId;
      return;
    }

    if (!libraryAutoSyncEnabled) {
      manager.stop();
      previousServerId.current = activeServerId;
      return;
    }

    const serverChanged = previousServerId.current !== null && previousServerId.current !== activeServerId;
    manager.trigger(serverChanged ? 'server-switch' : 'startup', {
      force: true,
      interrupt: serverChanged,
    });
    previousServerId.current = activeServerId;
  }, [isAuthenticated, activeServerId, libraryAutoSyncEnabled]);

  useEffect(() => {
    const manager = getLibrarySyncManager();

    const handleOnline = () => manager.trigger('online');
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        manager.trigger('visibility');
      }
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // Apply theme to html element
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  // Apply accent color to CSS custom properties
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--color-accent', accentColor);
    root.style.setProperty('--color-accent-hover', darkenHex(accentColor, 8));
  }, [accentColor]);

  // Command palette shortcut (Ctrl+K / Cmd+K)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const { commandPaletteOpen, openCommandPalette, closeCommandPalette } = useUIStore.getState();
        if (commandPaletteOpen) closeCommandPalette();
        else openCommandPalette();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const radioMode = usePlayerStore((s) => s.radioMode);
  const popOutPlayerOpen = useUIStore((s) => s.popOutPlayerOpen);
  const shortcutsOverlayOpen = useUIStore((s) => s.shortcutsOverlayOpen);
  const setShortcutsOverlayOpen = useUIStore((s) => s.setShortcutsOverlayOpen);
  const hasPlayback = currentSong !== null || radioMode !== null;
  const showMiniPlayer =
    hasPlayback && !HIDE_MINIPLAYER_ROUTES.includes(location.pathname);
  const showSidebar =
    isAuthenticated && !HIDE_SIDEBAR_ROUTES.includes(location.pathname);
  const showRightPane =
    isAuthenticated && hasPlayback && !HIDE_SIDEBAR_ROUTES.includes(location.pathname);

  return (
    <div className="flex h-dvh flex-col bg-bg-primary text-text-primary">
      {isAuthenticated && <CommandPalette />}
      <ShortcutsOverlay
        open={shortcutsOverlayOpen}
        onClose={() => setShortcutsOverlayOpen(false)}
      />
      <div className="flex flex-1 overflow-hidden">
        {showSidebar && <Sidebar />}
        <div className="flex-1 overflow-y-auto">
        <ChunkErrorBoundary pathname={location.pathname}>
        <Suspense fallback={<LoadingSpinner />}>
          <Routes>
            <Route path="/login" element={<LoginScreen />} />
            <Route
              path="/share"
              element={(
                <OfflineLazyRoute pathname="/share">
                  <ShareScreen />
                </OfflineLazyRoute>
              )}
            />

            {/* Protected routes */}
            <Route
              path="/"
              element={isAuthenticated ? <LibraryScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/artists"
              element={isAuthenticated ? <ArtistsScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/artist/:artistId"
              element={isAuthenticated ? <ArtistDetailScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/albums"
              element={isAuthenticated ? <AlbumsListScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/album/:albumId"
              element={isAuthenticated ? <AlbumDetailScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/songs"
              element={isAuthenticated ? <SongsScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/genres"
              element={isAuthenticated ? <GenresScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/generations"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/generations">
                  <GenerationsScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/favorites"
              element={isAuthenticated ? <FavoritesScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/folders"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/folders">
                  <FolderBrowserScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/folder/:folderId"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/folder/:folderId">
                  <FolderDetailScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/playlists"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/playlists">
                  <PlaylistsScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/playlist/:playlistId"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/playlist/:playlistId">
                  <PlaylistDetailScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/playlist/edit/:playlistId?"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/playlist/edit/:playlistId?">
                  <PlaylistEditorScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/smart-playlists"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/smart-playlists">
                  <SmartPlaylistScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/radio"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/radio">
                  <RadioScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/radio/search"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/radio/search">
                  <StationSearchScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/radio/add"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/radio/add">
                  <AddStationScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/search"
              element={isAuthenticated ? <SearchScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/settings"
              element={isAuthenticated ? <SettingsScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/settings/servers"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/settings/servers">
                  <ServerManagerScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />
            <Route
              path="/downloads"
              element={isAuthenticated ? <DownloadsScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/now-playing"
              element={isAuthenticated ? <NowPlayingScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/queue"
              element={isAuthenticated ? <QueueScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/lyrics"
              element={isAuthenticated ? <LyricsScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/eq"
              element={isAuthenticated ? <EQScreen /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/visualizer"
              element={isAuthenticated ? (
                <OfflineLazyRoute pathname="/visualizer">
                  <VisualizerScreen />
                </OfflineLazyRoute>
              ) : <Navigate to="/login" replace />}
            />

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        </ChunkErrorBoundary>
        </div>
        {showRightPane && <RightPane />}
      </div>

      {showMiniPlayer && (
        <MiniPlayer />
      )}

      {popOutPlayerOpen && hasPlayback && (
        <PopOutPlayer onClose={() => useUIStore.getState().setPopOutPlayerOpen(false)} />
      )}
    </div>
  );
}
