import { useEffect, useMemo, useState } from 'react';
import {
  deleteDictionary,
  getInstalledDictionaries,
  importDictionaryZip,
  type YomitanDictionarySummary,
} from '../../utils/yomitan/core';
import {
  loadDictionaryPreferences,
  moveDictionaryPreference,
  normalizeDictionaryPreferences,
  saveDictionaryPreferences,
  type DictionaryPreference,
} from '../../utils/yomitan/preferences';
import {
  RECOMMENDED_DICTIONARIES,
  buildRecommendedDictionaryProxyUrl,
} from '../../utils/yomitan/recommendedDictionaries';

interface StatusState {
  tone: 'neutral' | 'success' | 'error';
  message: string;
}

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        redirect: 'follow',
      });

      if (response.ok) {
        return response;
      }

      if (response.status >= 500 && attempt < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt * 400));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt * 400));
      }
    }
  }

  throw lastError ?? new Error('Failed to fetch recommended dictionary');
}

export default function YomitanSettings() {
  const [installedDictionaries, setInstalledDictionaries] = useState<YomitanDictionarySummary[]>([]);
  const [preferences, setPreferences] = useState<DictionaryPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusState>({
    tone: 'neutral',
    message: 'Load dictionaries to manage lookup order and enabled state.',
  });
  const [installingRecommended, setInstallingRecommended] = useState(false);

  const preferenceMap = useMemo(
    () => new Map(preferences.map((item, index) => [item.title, { preference: item, index }])),
    [preferences],
  );

  const refreshDictionaries = async (statusMessage?: StatusState) => {
    setLoading(true);

    try {
      const installed = await getInstalledDictionaries();
      const normalizedPreferences = normalizeDictionaryPreferences(
        installed.map((item) => item.title),
        loadDictionaryPreferences(),
      );

      saveDictionaryPreferences(normalizedPreferences);
      setInstalledDictionaries(installed);
      setPreferences(normalizedPreferences);
      setStatus(statusMessage ?? {
        tone: 'neutral',
        message: installed.length
          ? `Loaded ${installed.length} installed dictionaries.`
          : 'No dictionaries installed yet. Upload ZIP archives to enable dictionary mode in lyrics.',
      });
    } catch (error) {
      console.error('Failed to refresh Yomitan dictionaries:', error);
      setStatus({
        tone: 'error',
        message: 'Failed to load Yomitan dictionaries.',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    queueMicrotask(() => {
      void refreshDictionaries();
    });
  }, []);

  const persistPreferences = (nextPreferences: DictionaryPreference[], message?: string) => {
    setPreferences(nextPreferences);
    saveDictionaryPreferences(nextPreferences);

    if (message) {
      setStatus({
        tone: 'success',
        message,
      });
    }
  };

  const handleFileSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length === 0) return;

    let imported = 0;
    let failed = 0;

    setStatus({
      tone: 'neutral',
      message: `Importing ${files.length} dictionary ZIP${files.length === 1 ? '' : 's'}…`,
    });

    for (let index = 0; index < files.length; index++) {
      const file = files[index];

      try {
        setStatus({
          tone: 'neutral',
          message: `Importing ${file.name} (${index + 1}/${files.length})…`,
        });
        await importDictionaryZip(await file.arrayBuffer());
        imported++;
      } catch (error) {
        failed++;
        console.error(`Failed importing Yomitan dictionary ${file.name}:`, error);
      }
    }

    await refreshDictionaries({
      tone: failed === 0 ? 'success' : 'error',
      message:
        failed === 0
          ? `Imported ${imported} dictionary ZIP${imported === 1 ? '' : 's'}.`
          : `Imported ${imported}, failed ${failed}.`,
    });

    event.target.value = '';
  };

  const handleInstallRecommended = async () => {
    setInstallingRecommended(true);
    setStatus({
      tone: 'neutral',
      message: `Installing ${RECOMMENDED_DICTIONARIES.length} recommended dictionaries…`,
    });

    let imported = 0;
    let failed = 0;
    let proxyUnavailable = false;

    for (let index = 0; index < RECOMMENDED_DICTIONARIES.length; index++) {
      const dictionary = RECOMMENDED_DICTIONARIES[index];

      try {
        setStatus({
          tone: 'neutral',
          message: `Downloading ${dictionary.title} (${index + 1}/${RECOMMENDED_DICTIONARIES.length})…`,
        });

        const response = await fetchWithRetry(buildRecommendedDictionaryProxyUrl(dictionary.url));
        if (!response.ok) {
          if (response.status === 404) {
            proxyUnavailable = true;
            break;
          }

          throw new Error(`HTTP ${response.status}`);
        }

        const archive = await response.arrayBuffer();

        setStatus({
          tone: 'neutral',
          message: `Importing ${dictionary.title} (${index + 1}/${RECOMMENDED_DICTIONARIES.length})…`,
        });

        await importDictionaryZip(archive);
        imported++;
      } catch (error) {
        if (error instanceof TypeError) {
          proxyUnavailable = true;
          break;
        }

        failed++;
        console.error(`Failed installing recommended dictionary ${dictionary.title}:`, error);
      }
    }

    setInstallingRecommended(false);

    await refreshDictionaries(
      proxyUnavailable
        ? {
            tone: 'error',
            message:
              'Recommended dictionary downloads currently require a Vercel deployment. Upload the ZIP files manually on this install.',
          }
        : failed === 0
          ? {
              tone: 'success',
              message: `Installed ${imported} recommended dictionaries.`,
            }
          : {
              tone: 'error',
              message: `Installed ${imported}, failed ${failed} recommended dictionaries.`,
            },
    );
  };

  const handleDeleteDictionary = async (title: string) => {
    if (!window.confirm(`Delete dictionary "${title}"?`)) return;

    setStatus({
      tone: 'neutral',
      message: `Deleting ${title}…`,
    });

    try {
      await deleteDictionary(title);
      await refreshDictionaries({
        tone: 'success',
        message: `Deleted ${title}.`,
      });
    } catch (error) {
      console.error(`Failed deleting Yomitan dictionary ${title}:`, error);
      setStatus({
        tone: 'error',
        message: `Failed to delete ${title}.`,
      });
    }
  };

  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
        Yomitan
      </h2>
      <div className="space-y-4 rounded-lg bg-bg-secondary p-4">
        <div className="space-y-2">
          <label
            htmlFor="yomitan-dictionary-upload"
            className="block text-sm font-medium text-text-primary"
          >
            Upload dictionaries (.zip)
          </label>
          <input
            id="yomitan-dictionary-upload"
            type="file"
            accept=".zip"
            multiple
            onChange={handleFileSelection}
            className="block w-full cursor-pointer rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-accent/15 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-accent"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void handleInstallRecommended()}
            disabled={installingRecommended || loading}
            className="rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {installingRecommended ? 'Installing…' : 'Install recommended dictionaries'}
          </button>
          <button
            onClick={() => void refreshDictionaries()}
            disabled={loading}
            className="rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        <div
          role="status"
          className={`rounded-lg border px-3 py-2 text-xs ${
            status.tone === 'error'
              ? 'border-red-500/30 bg-red-500/10 text-red-300'
              : status.tone === 'success'
                ? 'border-accent/30 bg-accent/10 text-accent'
                : 'border-border bg-bg-tertiary text-text-secondary'
          }`}
        >
          {status.message}
        </div>

        <div className="rounded-lg border border-border bg-bg-tertiary/50">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div>
              <h3 className="text-sm font-medium text-text-primary">Installed dictionaries</h3>
              <p className="text-xs text-text-muted">
                Toggle dictionaries on or off and reorder them to change lookup priority.
              </p>
            </div>
            <span className="text-xs text-text-muted">{installedDictionaries.length} installed</span>
          </div>

          <div className="divide-y divide-border">
            {installedDictionaries.length === 0 && (
              <div className="px-3 py-4 text-sm text-text-muted">
                No dictionaries installed.
              </div>
            )}

            {installedDictionaries.map((dictionary) => {
              const preferenceEntry = preferenceMap.get(dictionary.title);
              const preference = preferenceEntry?.preference ?? { title: dictionary.title, enabled: true };
              const index = preferenceEntry?.index ?? -1;

              return (
                <div key={dictionary.title} className="space-y-3 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">{dictionary.title}</p>
                      <p className="text-xs text-text-muted">
                        Revision {dictionary.revision} • Imported {new Date(dictionary.importDate).toLocaleString()}
                      </p>
                    </div>

                    <button
                      role="switch"
                      aria-label={`Enable ${dictionary.title}`}
                      aria-checked={preference.enabled}
                      onClick={() => {
                        const nextPreferences = preferences.map((item) =>
                          item.title === dictionary.title ? { ...item, enabled: !item.enabled } : item,
                        );
                        persistPreferences(nextPreferences, `${dictionary.title} ${preference.enabled ? 'disabled' : 'enabled'}.`);
                      }}
                      className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
                        preference.enabled ? 'bg-accent' : 'bg-bg-primary'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                          preference.enabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        const nextPreferences = moveDictionaryPreference(preferences, index, index - 1);
                        persistPreferences(nextPreferences, `${dictionary.title} moved up in lookup priority.`);
                      }}
                      disabled={index <= 0}
                      className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-primary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Move up
                    </button>
                    <button
                      onClick={() => {
                        const nextPreferences = moveDictionaryPreference(preferences, index, index + 1);
                        persistPreferences(nextPreferences, `${dictionary.title} moved down in lookup priority.`);
                      }}
                      disabled={index === -1 || index >= preferences.length - 1}
                      className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-primary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Move down
                    </button>
                    <button
                      onClick={() => void handleDeleteDictionary(dictionary.title)}
                      className="rounded-lg border border-red-500/30 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <p className="text-xs text-text-muted">
          Installed dictionaries live only on this device and are not included in settings export/import.
        </p>
      </div>
    </section>
  );
}
