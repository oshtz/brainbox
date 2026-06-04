import type {
  BackendSearchResult,
  BackendUrlMetadata,
  BackendVault,
  BackendVaultItem,
} from '../types';

export interface BrainboxE2EFixture {
  vaults: BackendVault[];
  itemsByVaultId: Record<string, BackendVaultItem[]>;
  metadataByUrl?: Record<string, BackendUrlMetadata>;
  searchResultsByQuery?: Record<string, BackendSearchResult[]>;
}

declare global {
  interface Window {
    __BRAINBOX_E2E_FIXTURE__?: BrainboxE2EFixture;
  }
}

const fixtureIsEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('fixture') === 'e2e';
};

export const getE2EFixture = (): BrainboxE2EFixture | null => {
  if (!fixtureIsEnabled()) return null;
  return window.__BRAINBOX_E2E_FIXTURE__ ?? null;
};

export const listE2EVaults = (): BackendVault[] => {
  return getE2EFixture()?.vaults ?? [];
};

export const listE2EItems = (vaultId: string | number): BackendVaultItem[] => {
  const fixture = getE2EFixture();
  if (!fixture) return [];
  return fixture.itemsByVaultId[String(vaultId)] ?? [];
};

export const getE2EItem = (
  itemId: string | number,
  candidateVaultIds?: Array<string | number>
): BackendVaultItem | null => {
  const fixture = getE2EFixture();
  if (!fixture) return null;

  const vaultIds = candidateVaultIds?.length
    ? candidateVaultIds.map(String)
    : Object.keys(fixture.itemsByVaultId);

  for (const vaultId of vaultIds) {
    const item = fixture.itemsByVaultId[vaultId]?.find((candidate) => (
      String(candidate.id) === String(itemId)
    ));
    if (item) return item;
  }

  return null;
};

export const getE2EMetadata = (url: string): BackendUrlMetadata | null => {
  return getE2EFixture()?.metadataByUrl?.[url] ?? null;
};

export const searchE2EItems = (query: string, limit = 50): BackendSearchResult[] => {
  const fixture = getE2EFixture();
  if (!fixture) return [];

  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const configured = fixture.searchResultsByQuery?.[normalized] ?? fixture.searchResultsByQuery?.[query];
  if (configured) return configured.slice(0, limit);

  return Object.values(fixture.itemsByVaultId)
    .flat()
    .filter((item) => {
      const haystack = `${item.title} ${item.content} ${item.summary ?? ''}`.toLowerCase();
      return haystack.includes(normalized);
    })
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      vault_id: item.vault_id,
      title: item.title,
      content_preview: item.content.slice(0, 180),
      score: 1,
    }));
};
