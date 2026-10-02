/** Shared model cost shape used by Pi providers (includes cache accounting). */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl?: string;
  reasoning?: boolean;
  input: Array<"text" | "image">;
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  thinkingLevelMap?: Record<string, string | null | undefined>;
  [key: string]: unknown;
}

export interface CatalogSnapshot<T = CatalogModel> {
  version: string;
  etag?: string;
  fetchedAt: number;
  models: T[];
}

export const ZERO_COST: ModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function ensureCacheCost(cost?: Partial<ModelCost> | null): ModelCost {
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cacheRead: cost?.cacheRead ?? 0,
    cacheWrite: cost?.cacheWrite ?? 0,
  };
}
