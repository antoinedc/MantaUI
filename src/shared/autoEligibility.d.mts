export const MISSING: {
  IDENTITY: "identity";
  PRICE: "price";
  CACHING: "caching";
  QUALITY: "quality";
};

export interface OpencodeModel {
  providerID?: string;
  id?: string;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  capabilities?: Record<string, unknown>;
  limit?: { context?: number | null; output?: number };
}

export interface AutoEligibilityInput {
  model: OpencodeModel;
  identity?: { catalogId?: string; known?: boolean };
  quality?: { score?: number; known?: boolean };
  declared?: {
    catalogId?: string;
    price?: { input?: number; output?: number } | "free";
    caches?: boolean | { read?: boolean; write?: boolean };
  };
  providerClass: "supported" | "custom";
}

export interface AutoEligibilityResult {
  eligible: boolean;
  missing: string[];
}

export function autoEligibility(input: AutoEligibilityInput): AutoEligibilityResult;
