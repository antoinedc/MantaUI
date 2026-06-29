import { describe, it, expect } from "vitest";
import { parseModelsResponse } from "./providers.js";

describe("parseModelsResponse", () => {
  it("extracts ids from a valid OpenAI /v1/models body", () => {
    const body = JSON.stringify({
      object: "list",
      data: [
        { id: "qwen3.6-27b", object: "model" },
        { id: "default", object: "model" },
        { id: "ornith", object: "model" },
      ],
    });
    expect(parseModelsResponse(body)).toEqual({
      ok: true,
      models: [{ id: "qwen3.6-27b" }, { id: "default" }, { id: "ornith" }],
    });
  });

  it("returns ok:true with empty list when data is empty", () => {
    expect(parseModelsResponse(JSON.stringify({ data: [] }))).toEqual({
      ok: true,
      models: [],
    });
  });

  it("returns bad_response for non-JSON", () => {
    const r = parseModelsResponse("<html>502 Bad Gateway</html>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_response");
  });

  it("returns unauthorized when body looks like an auth error", () => {
    const body = JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } });
    const r = parseModelsResponse(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unauthorized");
  });

  it("returns bad_response when JSON lacks a data array", () => {
    const r = parseModelsResponse(JSON.stringify({ object: "list" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_response");
  });
});
