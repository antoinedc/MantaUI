export interface BuiltinSource {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly via?: string;
}
export declare const BUILTIN_SOURCES: readonly BuiltinSource[];
export declare const DEFAULT_ORDER: readonly string[];
export declare function isBuiltinSourceId(id: string): boolean;
export declare function builtinSource(id: string): BuiltinSource | null;
export declare const BUILTIN_NOT_REMOVABLE: string;
export declare const SOURCES_IN_SETTINGS: string;
