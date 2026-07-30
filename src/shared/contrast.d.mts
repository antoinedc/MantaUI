// Hand-written type declarations for contrast.mjs. The implementation is
// plain JS so it can be imported by both Node-side modules and the renderer
// test suite (vitest .ts file). Keep this in sync with src/shared/contrast.mjs.

export type ContrastPair = {
  fg: string;
  bg: string;
  min: number;
};

export type ContrastFailure = ContrastPair & {
  fgHex: string;
  bgHex: string;
  ratio: number;
};

export type ThemeVars = Record<string, string>;

export function hexToRgb(hex: string): [number, number, number];

export function relativeLuminance(hex: string): number;

export function contrastRatio(a: string, b: string): number;

export const TOKEN_PAIRS: ContrastPair[];

export function parseThemeVars(theme: string, css?: string): ThemeVars;

export function checkContrast(
  theme: string,
  vars?: ThemeVars,
): ContrastFailure[];
