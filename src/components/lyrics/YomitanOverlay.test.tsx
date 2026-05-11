import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import YomitanOverlay from './YomitanOverlay';

const coreMocks = vi.hoisted(() => ({
  lookupTerm: vi.fn(),
}));

vi.mock('../../utils/yomitan/core', async () => {
  const actual = await vi.importActual<typeof import('../../utils/yomitan/core')>('../../utils/yomitan/core');
  return {
    ...actual,
    lookupTerm: coreMocks.lookupTerm,
  };
});

vi.mock('./YomitanResults', () => ({
  default: ({ entries }: { entries: Array<{ id: string }> }) => (
    <div data-testid="yomitan-results">{entries[0]?.id ?? 'empty'}</div>
  ),
}));

function TestHarness() {
  const [selectedTokenIndex, setSelectedTokenIndex] = useState(0);

  return (
    <YomitanOverlay
      open
      tokens={[
        { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' },
        { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
      ]}
      selectedTokenIndex={selectedTokenIndex}
      dictionaries={[]}
      enabledDictionaryMap={new Map([['JMdict', { index: 0, priority: 0 }]])}
      onSelectToken={setSelectedTokenIndex}
      onClose={() => {}}
    />
  );
}

describe('YomitanOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not show a loading message when switching dictionary tokens', async () => {
    let resolveSecondLookup: ((value: { entries: Array<{ id: string }>; originalTextLength: number }) => void) | null = null;

    coreMocks.lookupTerm
      .mockImplementationOnce(async (term: string) => ({
        entries: [{ id: term }],
        originalTextLength: term.length,
      }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondLookup = resolve;
          }),
      );

    render(<TestHarness />);

    await waitFor(() => {
      expect(screen.getByTestId('yomitan-results')).toHaveTextContent('日本語');
    });

    fireEvent.click(screen.getByRole('button', { name: '猫' }));

    expect(screen.queryByText(/Looking up/i)).toBeNull();
    expect(screen.getByTestId('yomitan-results')).toHaveTextContent('日本語');

    expect(resolveSecondLookup).not.toBeNull();
    resolveSecondLookup!({
      entries: [{ id: '猫' }],
      originalTextLength: 1,
    });

    await waitFor(() => {
      expect(screen.getByTestId('yomitan-results')).toHaveTextContent('猫');
    });
  });
});
