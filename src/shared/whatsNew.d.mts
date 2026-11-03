// Hand-written type declarations for whatsNew.mjs. Keep in sync with it.

/** What the decision needs of a changelog entry (the full shape is `ChangelogEntry` in api.ts). */
export type WhatsNewEntryLike = { version: string; fingerprint: string };

/** `localStorage["manta:whats-new:<serverId>"]`: acknowledged `{ [version]: fingerprint }`, oldest first. */
export type WhatsNewStored = { versions: Record<string, string> };

export type WhatsNewDecision<E extends WhatsNewEntryLike> = { baseline: true; unseen?: undefined } | { baseline?: undefined; unseen: E[] };

export const MAX_SHOWN_ENTRIES: 5;
export const MAX_STORED_VERSIONS: 50;

export function normalizeStored(raw: unknown): WhatsNewStored | null;
export function decideWhatsNew<E extends WhatsNewEntryLike>(stored: unknown, entries: readonly E[]): WhatsNewDecision<E>;
export function acknowledge(stored: unknown, entries: readonly WhatsNewEntryLike[]): WhatsNewStored;
export function previousVersion(stored: unknown, entries: readonly WhatsNewEntryLike[], unseen: readonly WhatsNewEntryLike[]): string | null;
export function componentChips(components: readonly string[] | null | undefined): string[];
