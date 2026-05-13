import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import YomitanSettings from './YomitanSettings';

const coreMocks = vi.hoisted(() => ({
  getInstalledDictionaries: vi.fn(),
  importDictionaryZip: vi.fn(),
  deleteDictionary: vi.fn(),
}));

const preferenceMocks = vi.hoisted(() => ({
  loadDictionaryPreferences: vi.fn(),
  normalizeDictionaryPreferences: vi.fn(),
  saveDictionaryPreferences: vi.fn(),
  moveDictionaryPreference: vi.fn((preferences, fromIndex, toIndex) => {
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= preferences.length ||
      toIndex >= preferences.length ||
      fromIndex === toIndex
    ) {
      return preferences;
    }

    const next = [...preferences];
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item);
    return next;
  }),
}));

const offlineLyricsStoreMocks = vi.hoisted(() => ({
  clearOfflineTokenizedLyrics: vi.fn(),
}));

const tokenizationManagerMocks = vi.hoisted(() => ({
  clearLyricsTokenizationCache: vi.fn(),
}));

vi.mock('../../utils/yomitan/core', () => coreMocks);
vi.mock('../../utils/yomitan/preferences', () => preferenceMocks);
vi.mock('../../utils/offlineLyricsStore', () => offlineLyricsStoreMocks);
vi.mock('../../utils/lyricsTokenizationManager', () => tokenizationManagerMocks);

describe('YomitanSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('confirm', vi.fn(() => true));

    coreMocks.getInstalledDictionaries.mockResolvedValue([
      { title: 'JMdict', importDate: Date.now(), revision: '1', version: 3 },
      { title: 'KANJIDIC', importDate: Date.now() - 1000, revision: '1', version: 3 },
    ]);
    coreMocks.importDictionaryZip.mockResolvedValue({});
    coreMocks.deleteDictionary.mockResolvedValue(undefined);
    offlineLyricsStoreMocks.clearOfflineTokenizedLyrics.mockResolvedValue(2);
    preferenceMocks.loadDictionaryPreferences.mockReturnValue([
      { title: 'JMdict', enabled: true },
      { title: 'KANJIDIC', enabled: true },
    ]);
    preferenceMocks.normalizeDictionaryPreferences.mockImplementation((_installed, existing) => existing);
  });

  it('renders the installed dictionary list', async () => {
    render(<YomitanSettings />);

    await waitFor(() => {
      expect(screen.getByText('JMdict')).toBeInTheDocument();
      expect(screen.getByText('KANJIDIC')).toBeInTheDocument();
    });
  });

  it('imports uploaded dictionary zip files', async () => {
    render(<YomitanSettings />);
    await waitFor(() => expect(coreMocks.getInstalledDictionaries).toHaveBeenCalled());

    const input = screen.getByLabelText('Upload dictionaries (.zip)') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'dict.zip', { type: 'application/zip' });

    await fireEvent.change(input, {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(coreMocks.importDictionaryZip).toHaveBeenCalledTimes(1);
    });
  });

  it('deletes an installed dictionary', async () => {
    render(<YomitanSettings />);

    await waitFor(() => expect(screen.getByText('JMdict')).toBeInTheDocument());

    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(coreMocks.deleteDictionary).toHaveBeenCalledWith('JMdict');
    });
  });

  it('updates dictionary priority order with move controls', async () => {
    render(<YomitanSettings />);

    await waitFor(() => expect(screen.getByText('JMdict')).toBeInTheDocument());

    const moveDownButtons = screen.getAllByRole('button', { name: 'Move down' });
    await fireEvent.click(moveDownButtons[0]);

    expect(preferenceMocks.saveDictionaryPreferences).toHaveBeenLastCalledWith([
      { title: 'KANJIDIC', enabled: true },
      { title: 'JMdict', enabled: true },
    ]);
  });

  it('installs recommended dictionaries through the proxy path', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () =>
      new Response(new Uint8Array([1, 2, 3]).buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      }),
    );

    render(<YomitanSettings />);
    await waitFor(() => expect(coreMocks.getInstalledDictionaries).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole('button', { name: 'Install recommended dictionaries' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(coreMocks.importDictionaryZip).toHaveBeenCalledTimes(4);
      expect(screen.getByText('Installed 4 recommended dictionaries.')).toBeInTheDocument();
    });
  });

  it('shows a manual upload fallback message when the proxy is unavailable', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    render(<YomitanSettings />);
    await waitFor(() => expect(coreMocks.getInstalledDictionaries).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole('button', { name: 'Install recommended dictionaries' }));

    await waitFor(() => {
      expect(screen.getByText(/currently require a Vercel deployment/i)).toBeInTheDocument();
    });
  });

  it('clears persisted lyric tokenization cache from settings', async () => {
    render(<YomitanSettings />);
    await waitFor(() => expect(coreMocks.getInstalledDictionaries).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole('button', { name: 'Clear tokenization cache' }));

    await waitFor(() => {
      expect(offlineLyricsStoreMocks.clearOfflineTokenizedLyrics).toHaveBeenCalledTimes(1);
      expect(tokenizationManagerMocks.clearLyricsTokenizationCache).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Cleared cached lyric tokenization for 2 songs.')).toBeInTheDocument();
    });
  });
});
