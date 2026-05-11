import { ALLOWED_RECOMMENDED_DICTIONARY_URLS } from '../src/utils/yomitan/recommendedDictionaries';

type RequestLike = {
  query?: Record<string, string | string[] | undefined>;
};

type ResponseLike = {
  status: (code: number) => ResponseLike;
  json: (body: unknown) => void;
  send: (body: Buffer) => void;
  setHeader: (name: string, value: string) => void;
  end: () => void;
  write: (chunk: Uint8Array) => void;
  statusCode: number;
};

function getQueryValue(value: string | string[] | undefined) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? '';
  return '';
}

export default async function handler(request: RequestLike, response: ResponseLike) {
  const url = getQueryValue(request.query?.url);

  if (!url) {
    response.status(400).json({ error: 'Missing url query parameter.' });
    return;
  }

  if (!ALLOWED_RECOMMENDED_DICTIONARY_URLS.has(url)) {
    response.status(403).json({ error: 'URL is not allowlisted.' });
    return;
  }

  try {
    const upstream = await fetch(url, {
      redirect: 'follow',
    });

    if (!upstream.ok || !upstream.body) {
      response.status(502).json({ error: 'Failed to fetch recommended dictionary.' });
      return;
    }

    response.statusCode = 200;

    const forwardedHeaders = [
      ['content-type', upstream.headers.get('content-type') || 'application/zip'],
      ['content-disposition', upstream.headers.get('content-disposition')],
      ['content-length', upstream.headers.get('content-length')],
      ['etag', upstream.headers.get('etag')],
      ['last-modified', upstream.headers.get('last-modified')],
    ] as const;

    for (const [header, value] of forwardedHeaders) {
      if (value) {
        response.setHeader(header, value);
      }
    }

    response.setHeader('cache-control', 'public, max-age=3600, s-maxage=3600');

    for await (const chunk of upstream.body) {
      response.write(chunk);
    }

    response.end();
  } catch (error) {
    console.error('Recommended dictionary proxy failed:', error);
    response.status(502).json({ error: 'Failed to proxy recommended dictionary.' });
  }
}
