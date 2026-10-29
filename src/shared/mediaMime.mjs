// THE box's extension → MIME allowlist (media tools' returns AND the artifacts
// list). Video is never measured (see readImageSize) — its mime is still
// reported from the extension. Deliberately an allowlist, not a MIME database:
// a full database would label `.ts` as `video/mp2t` and widen what gets
// previewed; unknown types land on the download path.
export const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
};
