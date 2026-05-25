import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareAutoplayTail } from './queueAutoplay';
import type { Song } from '../types/subsonic';

const getSimilarSongs2Mock = vi.fn();
const getRandomSongsMock = vi.fn();

vi.mock('../api/SubsonicClient', () => ({
  getSubsonicClient: () => ({
    getSimilarSongs2: getSimilarSongs2Mock,
    getRandomSongs: getRandomSongsMock,
  }),
}));

const makeSong = (id: string): Song => ({
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  album: 'Album',
  duration: 180,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('queueAutoplay', () => {
  beforeEach(() => {
    getSimilarSongs2Mock.mockReset();
    getRandomSongsMock.mockReset();
    getSimilarSongs2Mock.mockResolvedValue([]);
    getRandomSongsMock.mockResolvedValue([]);
  });

  it('appends similar songs after explicit queue', async () => {
    const explicitQueue = [makeSong('1'), makeSong('2')];
    const similarSongs = Array.from({ length: 12 }, (_, index) => makeSong(`s${index}`));
    getSimilarSongs2Mock.mockResolvedValue(similarSongs);

    const result = await prepareAutoplayTail({
      seedSong: explicitQueue[1],
      explicitQueue,
    });

    expect(result.status).toBe('ready');
    expect(result.songs.map((song) => song.id)).toEqual(similarSongs.map((song) => song.id));
  });

  it('removes duplicate candidates', async () => {
    const explicitQueue = [makeSong('1'), makeSong('2')];
    getSimilarSongs2Mock.mockResolvedValue([
      makeSong('2'),
      makeSong('dup'),
      makeSong('dup'),
      makeSong('uniq'),
    ]);
    getRandomSongsMock.mockResolvedValue([]);

    const result = await prepareAutoplayTail({
      seedSong: explicitQueue[0],
      explicitQueue,
    });

    expect(result.songs.map((song) => song.id)).toEqual(['dup', 'uniq']);
  });

  it('uses random fallback when similar songs are empty', async () => {
    const explicitQueue = [makeSong('1')];
    const randomSongs = Array.from({ length: 5 }, (_, index) => makeSong(`r${index}`));
    getSimilarSongs2Mock.mockResolvedValue([]);
    getRandomSongsMock.mockResolvedValue(randomSongs);

    const result = await prepareAutoplayTail({
      seedSong: explicitQueue[0],
      explicitQueue,
    });

    expect(result.status).toBe('fallback');
    expect(result.songs.map((song) => song.id)).toEqual(randomSongs.map((song) => song.id));
  });

  it('leaves queue unchanged when both sources are empty', async () => {
    const explicitQueue = [makeSong('1')];

    const result = await prepareAutoplayTail({
      seedSong: explicitQueue[0],
      explicitQueue,
    });

    expect(result).toEqual({ songs: [], status: 'empty' });
  });

  it('ignores stale async responses', async () => {
    const explicitQueue = [makeSong('1')];
    const pending = deferred<Song[]>();
    let stale = false;
    getSimilarSongs2Mock.mockReturnValueOnce(pending.promise);

    const promise = prepareAutoplayTail({
      seedSong: explicitQueue[0],
      explicitQueue,
      isStale: () => stale,
    });

    stale = true;
    pending.resolve([makeSong('late')]);

    await expect(promise).resolves.toEqual({ songs: [], status: 'stale' });
  });

  it('passes active music folder into random fallback', async () => {
    const explicitQueue = [makeSong('1')];
    getSimilarSongs2Mock.mockResolvedValue([]);
    getRandomSongsMock.mockResolvedValue([makeSong('r1')]);

    await prepareAutoplayTail({
      seedSong: explicitQueue[0],
      explicitQueue,
      activeFolderId: 'folder-1',
    });

    expect(getRandomSongsMock).toHaveBeenCalledWith(25, undefined, 'folder-1');
  });
});
