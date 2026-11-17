// A fake forge `request` for adapter tests: answers each URL from `map` (an
// Error value is thrown) and records every call as {url, opts} on `.calls`.
export function recordingRequest(map) {
  const calls = [];
  const request = async (url, opts) => {
    calls.push({ url, opts });
    const v = map[url];
    if (v instanceof Error) throw v;
    return { data: v, stale: false };
  };
  request.calls = calls;
  return request;
}
