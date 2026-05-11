import { beforeEach, describe, expect, it, vi } from 'vitest';

const initializeMock = vi.fn();
const getDictionaryInfoMock = vi.fn();
const importDictionaryMock = vi.fn();
const deleteDictionaryMock = vi.fn();
const parseTextMock = vi.fn();
const findTermsMock = vi.fn();
const constructorMock = vi.fn(class MockYomitanCore {
  initialize = initializeMock;
  getDictionaryInfo = getDictionaryInfoMock;
  importDictionary = importDictionaryMock;
  deleteDictionary = deleteDictionaryMock;
  parseText = parseTextMock;
  findTerms = findTermsMock;
});
const rendererFactoryMock = vi.fn();

describe('yomitan core wrapper', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    rendererFactoryMock.mockReturnValue({ prepareHost: vi.fn(), renderTermEntries: vi.fn(), updateHost: vi.fn(), destroy: vi.fn() });
  });

  async function importModule() {
    vi.doMock('yomitan-core', () => ({
      default: constructorMock,
    }));
    vi.doMock('yomitan-core/render', () => ({
      createTermEntryRenderer: rendererFactoryMock,
    }));

    return await import('./core');
  }

  it('keeps initialization lazy until a core-backed function is called', async () => {
    const module = await importModule();

    module.buildEnabledDictionaryMap([{ title: 'JMdict', enabled: true }]);

    expect(constructorMock).not.toHaveBeenCalled();
  });

  it('initializes the singleton once and reuses it', async () => {
    initializeMock.mockResolvedValue(undefined);
    getDictionaryInfoMock.mockResolvedValue([]);

    const module = await importModule();

    await module.getInstalledDictionaries();
    await module.getInstalledDictionaries();

    expect(constructorMock).toHaveBeenCalledTimes(1);
    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(getDictionaryInfoMock).toHaveBeenCalledTimes(2);
  });

  it('builds the enabled dictionary map in preference order', async () => {
    const module = await importModule();
    const map = module.buildEnabledDictionaryMap([
      { title: 'KANJIDIC', enabled: true },
      { title: 'JMdict', enabled: false },
      { title: 'JPDB Frequency', enabled: true },
    ]);

    expect([...map.entries()]).toEqual([
      ['KANJIDIC', { index: 0, priority: 0 }],
      ['JPDB Frequency', { index: 1, priority: 0 }],
    ]);
  });

  it('handles an empty installed dictionary list gracefully', async () => {
    initializeMock.mockResolvedValue(undefined);
    getDictionaryInfoMock.mockResolvedValue([]);

    const module = await importModule();

    await expect(module.getInstalledDictionaries()).resolves.toEqual([]);
  });
});
