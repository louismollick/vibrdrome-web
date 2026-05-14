import { useEffect, useMemo, useState } from 'react';
import YomitanResults from './YomitanResults';
import type {
  YomitanDictionarySummary,
  YomitanEnabledDictionaryMap,
  YomitanLookupResult,
  YomitanToken,
} from '../../utils/yomitan/core';
import { lookupTerm } from '../../utils/yomitan/core';

interface YomitanOverlayProps {
  open: boolean;
  tokens: YomitanToken[];
  selectedTokenIndex: number;
  dictionaries: YomitanDictionarySummary[];
  enabledDictionaryMap: YomitanEnabledDictionaryMap;
  onSelectToken: (index: number) => void;
  onClose: () => void;
}

export default function YomitanOverlay({
  open,
  tokens,
  selectedTokenIndex,
  dictionaries,
  enabledDictionaryMap,
  onSelectToken,
  onClose,
}: YomitanOverlayProps) {
  const [lookupState, setLookupState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    result: YomitanLookupResult | null;
    message: string | null;
  }>({
    status: 'idle',
    result: null,
    message: null,
  });

  const selectedToken = tokens[selectedTokenIndex] ?? null;
  const selectableTokens = useMemo(
    () => tokens.filter((token) => token.selectable),
    [tokens],
  );

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !selectedToken?.selectable) return;

    let cancelled = false;

    const runLookup = async () => {
      setLookupState((current) => ({
        status: current.result?.entries.length ? 'ready' : 'idle',
        result: current.result?.entries.length ? current.result : null,
        message: null,
      }));

      return await lookupTerm(selectedToken.term || selectedToken.text, enabledDictionaryMap);
    };

    void runLookup()
      .then((result) => {
        if (cancelled) return;

        if (result.entries.length === 0) {
          setLookupState({
            status: 'ready',
            result,
            message: 'No dictionary entries found for this token.',
          });
          return;
        }

        setLookupState({
          status: 'ready',
          result,
          message: null,
        });
      })
      .catch((error) => {
        console.error('Failed to look up Yomitan term:', error);
        if (cancelled) return;
        setLookupState({
          status: 'error',
          result: null,
          message: 'Dictionary lookup failed for this token.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabledDictionaryMap, open, selectedToken]);

  if (!open || !selectedToken) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end bg-black/60 md:items-stretch md:justify-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Dictionary lookup"
    >
      <div
        className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-3xl border border-border bg-bg-secondary shadow-2xl md:h-full md:max-h-none md:w-[42rem] md:rounded-none md:rounded-l-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Dictionary</h2>
            <p className="text-xs text-text-muted">
              {selectedToken.reading ? `${selectedToken.text} • ${selectedToken.reading}` : selectedToken.text}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            aria-label="Close dictionary"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="h-5 w-5"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap gap-2">
            {tokens.map((token, index) => (
              token.selectable ? (
                <button
                  key={`${token.text}-${index}`}
                  onClick={() => onSelectToken(index)}
                  className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                    index === selectedTokenIndex
                      ? 'border-accent bg-accent/15 text-accent'
                      : 'border-border bg-bg-tertiary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {token.text}
                </button>
              ) : (
                <span
                  key={`${token.text}-${index}`}
                  className="rounded-full border border-transparent px-1 py-1 text-sm text-text-muted"
                >
                  {token.text}
                </span>
              )
            ))}
          </div>
          {selectableTokens.length === 0 && (
            <p className="mt-2 text-xs text-text-muted">No selectable terms found on this line.</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {lookupState.message && (
            <p className="text-sm text-text-secondary">{lookupState.message}</p>
          )}

          {lookupState.result && lookupState.result.entries.length > 0 && (
            <YomitanResults entries={lookupState.result.entries} dictionaries={dictionaries} />
          )}
        </div>
      </div>
    </div>
  );
}
