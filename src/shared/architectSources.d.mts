import type { ArchitectSource } from "./types";

export declare const SOURCE_ID_RE: RegExp;
export declare const BASE_SOURCE_IDS: readonly string[];
export declare const SOURCES_MAX: number;
export declare const SOURCE_NAME_MAX: number;
export declare const SOURCE_DESCRIPTION_MAX: number;
export declare const QUERY_MAX: number;
export declare const QUERY_TOKEN: "{query}";
export declare const SECRET_REF_RE: RegExp;
export declare const CREDENTIAL_HINT: string;
export declare const PRIVATE_SENTENCE: string;
export declare const PRIVATE_TO_PUBLIC_SENTENCE: string;

export declare function isCredentialHeader(name: string): boolean;
export declare function isCredentialEnv(name: string): boolean;
export declare function validateSource(raw: unknown): { ok: true; source: ArchitectSource & { private: boolean } } | { ok: false; error: string };
export declare function validateSourceList(raw: unknown): { ok: true; sources: (ArchitectSource & { private: boolean })[] } | { ok: false; error: string };
export declare function parseSourceList(raw: unknown): { sources: (ArchitectSource & { private: boolean })[]; notes: string[] };
export declare function hasYamlAliases(yamlText: string): boolean;
export declare function sourcesOfAgentMd(text: string): { sources: (ArchitectSource & { private: boolean })[]; notes: string[]; refused: boolean };
export declare function credentialLiterals(source: ArchitectSource): string[];
export declare function secretNamesOf(source: ArchitectSource): string[];
export interface SourceDescription {
  id: string;
  name: string;
  kind: "command" | "url";
  runs: string;
  host: string | null;
  secrets: string[];
  private: boolean;
  line: string;
}
export declare function describeSource(source: ArchitectSource): SourceDescription;
export interface SourceDiffRow {
  change: "added" | "changed" | "removed";
  source: ArchitectSource;
  privateToPublic: boolean;
}
export declare function diffSources(before: ArchitectSource[] | undefined, after: ArchitectSource[] | undefined): SourceDiffRow[];
