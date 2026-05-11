import { useEffect, useRef } from 'react';
import type { YomitanDictionarySummary, YomitanLookupResult } from '../../utils/yomitan/core';
import { createTermEntryRenderer } from '../../utils/yomitan/core';

interface YomitanResultsProps {
  entries: YomitanLookupResult['entries'];
  dictionaries: YomitanDictionarySummary[];
}

export default function YomitanResults({ entries, dictionaries }: YomitanResultsProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ReturnType<typeof createTermEntryRenderer> | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (!rendererRef.current) {
      rendererRef.current = createTermEntryRenderer({
        document,
        theme: 'dark',
        language: 'ja',
        glossaryLayoutMode: 'default',
        resultOutputMode: 'group',
      });
      rendererRef.current.prepareHost(host);
    } else {
      rendererRef.current.updateHost(host, {
        theme: 'dark',
        language: 'ja',
        glossaryLayoutMode: 'default',
        resultOutputMode: 'group',
      });
    }

    host.replaceChildren();

    const renderedEntries = rendererRef.current.renderTermEntries(entries, dictionaries);
    for (const renderedEntry of renderedEntries) {
      host.appendChild(renderedEntry.entryNode);
    }
  }, [dictionaries, entries]);

  useEffect(() => {
    return () => {
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  return <div ref={hostRef} data-testid="yomitan-results" aria-label="Yomitan dictionary results" />;
}
