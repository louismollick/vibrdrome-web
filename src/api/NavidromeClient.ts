import type { ServerConfig } from '../types/subsonic';
import type { NavidromeMediaFile, NavidromeTag } from '../types/navidrome';

type NavidromeAvailability = 'unknown' | 'available' | 'unavailable';

class NavidromeClient {
  private config: ServerConfig | null = null;
  private tokenCache = new Map<string, string>();
  private availabilityCache = new Map<string, NavidromeAvailability>();
  private lastSongsPageTotalCount: number | null = null;

  setConfig(server: ServerConfig): void {
    this.config = server;
  }

  isAvailable(): boolean {
    if (!this.config) return false;
    return this.availabilityCache.get(this.config.id) === 'available';
  }

  getAvailabilityStatus(): NavidromeAvailability {
    if (!this.config) return 'unknown';
    return this.availabilityCache.get(this.config.id) ?? 'unknown';
  }

  clearTokenCache(serverId?: string): void {
    if (serverId) {
      this.tokenCache.delete(serverId);
      this.availabilityCache.delete(serverId);
      return;
    }

    this.tokenCache.clear();
    this.availabilityCache.clear();
  }

  getLastSongsPageTotalCount(): number | null {
    return this.lastSongsPageTotalCount;
  }

  async login(): Promise<void> {
    const server = this.requireConfig();
    const response = await fetch(`${this.getBaseUrl()}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: server.username,
        password: server.password,
      }),
    });

    if (!response.ok) {
      this.availabilityCache.set(server.id, 'unavailable');
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json() as { token?: string };
    if (!json.token) {
      this.availabilityCache.set(server.id, 'unavailable');
      throw new Error('Navidrome login did not return a token');
    }

    this.tokenCache.set(server.id, json.token);
  }

  async getSongsPage(params: {
    start: number;
    end: number;
    sort: 'path';
    order: 'ASC';
    libraryId?: number;
  }): Promise<NavidromeMediaFile[]> {
    const query = new URLSearchParams({
      _start: String(params.start),
      _end: String(params.end),
      _sort: params.sort,
      _order: params.order,
    });

    if (params.libraryId !== undefined) {
      query.set('library_id', String(params.libraryId));
    }

    const response = await this.request(`/api/song?${query.toString()}`);
    const totalCount = response.headers.get('X-Total-Count');
    this.lastSongsPageTotalCount = totalCount ? Number(totalCount) : null;
    return await response.json() as NavidromeMediaFile[];
  }

  async getTags(params?: { libraryId?: number }): Promise<NavidromeTag[]> {
    const query = new URLSearchParams();
    if (params?.libraryId !== undefined) {
      query.set('library_id', String(params.libraryId));
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await this.request(`/api/tag${suffix}`);
    return await response.json() as NavidromeTag[];
  }

  private async request(path: string): Promise<Response> {
    const server = this.requireConfig();
    const token = this.tokenCache.get(server.id);

    if (!token) {
      throw new Error('NavidromeClient is not authenticated');
    }

    const response = await fetch(`${this.getBaseUrl()}${path}`, {
      headers: {
        'X-ND-Authorization': `Bearer ${token}`,
      },
    });

    this.refreshTokenFromResponse(response);

    if (!response.ok) {
      this.availabilityCache.set(server.id, 'unavailable');
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    this.availabilityCache.set(server.id, 'available');
    return response;
  }

  private refreshTokenFromResponse(response: Response) {
    if (!this.config) return;

    const refreshedHeader = response.headers.get('X-ND-Authorization');
    if (!refreshedHeader) return;

    const token = refreshedHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      this.tokenCache.set(this.config.id, token);
    }
  }

  private requireConfig() {
    if (!this.config) {
      throw new Error('NavidromeClient is not configured');
    }

    return this.config;
  }

  private getBaseUrl() {
    return this.requireConfig().url.replace(/\/+$/, '');
  }
}

let clientInstance: NavidromeClient | null = null;

export function getNavidromeClient() {
  if (!clientInstance) {
    clientInstance = new NavidromeClient();
  }

  return clientInstance;
}

export function clearNavidromeTokenCache(serverId?: string) {
  getNavidromeClient().clearTokenCache(serverId);
}

export default NavidromeClient;
