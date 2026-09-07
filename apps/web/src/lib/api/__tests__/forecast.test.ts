import { describe, expect, it, vi, afterEach } from "vitest";
import { forecast } from "../forecast";

afterEach(() => vi.restoreAllMocks());

describe("forecast()", () => {
  it("GET /api/forecast를 부른다", async () => {
    const body = { fetched_at: null, base_at: null, stale: false, hourly: [], daily: [], upcoming: [] };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(forecast()).resolves.toEqual(body);
    expect(spy.mock.calls[0]![0]).toBe("/api/forecast");
  });
});
