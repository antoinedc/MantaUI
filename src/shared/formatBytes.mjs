// formatBytes — "31 GB", "512 B"; "" for a non-positive / non-finite value.
// Shared by the renderer and the box (upgrade view wording, WS11 D3).
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val < 10 ? val.toFixed(1).replace(/\.0$/, "") : Math.round(val)} ${units[i]}`;
}
