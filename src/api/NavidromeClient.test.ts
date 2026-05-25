import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearNavidromeTokenCache, getNavidromeClient } from './NavidromeClient';

const fetchMock = vi.fn<typeof fetch>();
const client = getNavidromeClient();

beforeEach(() => {
  vi.clearAllMocks();
  clearNavidromeTokenCache();
  client.setConfig({
    id: 'server-1',
    name: 'Server',
    url: 'https://music.example.com/',
    username: 'navidrome-user',
    password: 'secret',
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('NavidromeClient', () => {
  it('login posts correct body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'token-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await client.login();

    expect(fetchMock).toHaveBeenCalledWith('https://music.example.com/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        username: 'navidrome-user',
        password: 'secret',
      }),
    }));
  });

  it('sends X-ND-Authorization on api requests', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'token-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Total-Count': '0',
        },
      }));

    await client.login();
    await client.getSongsPage({ start: 0, end: 250, sort: 'path', order: 'ASC' });

    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://music.example.com/api/song?_start=0&_end=250&_sort=path&_order=ASC',
      expect.objectContaining({
        headers: {
          'X-ND-Authorization': 'Bearer token-1',
        },
      }),
    );
  });

  it('replaces cached token from refreshed response header', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'token-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-ND-Authorization': 'Bearer token-2',
          'X-Total-Count': '0',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await client.login();
    await client.getSongsPage({ start: 0, end: 250, sort: 'path', order: 'ASC' });
    await client.getTags();

    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://music.example.com/api/tag',
      expect.objectContaining({
        headers: {
          'X-ND-Authorization': 'Bearer token-2',
        },
      }),
    );
  });

  it('marks the client unavailable when login or api requests fail', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401, statusText: 'Unauthorized' }));

    await expect(client.login()).rejects.toThrow(/401/);
    expect(client.isAvailable()).toBe(false);
    expect(client.getAvailabilityStatus()).toBe('unavailable');
  });
});
