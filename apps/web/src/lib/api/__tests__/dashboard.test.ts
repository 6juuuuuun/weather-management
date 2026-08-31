import { describe, expect, it, beforeEach, vi } from "vitest";
import { record } from "./contract";
import {
  latestObservation,
  observationsSince,
  observation,
  openEvents,
  criteria,
  saveCriteria,
  siteSettings,
  saveSiteSettings,
  heartbeat,
} from "../dashboard";

beforeEach(() => vi.restoreAllMocks());

// 대응하는 서버 라우트는 server/src/api/dashboard.ts에 있고 app.use("/api", ...)로
// 마운트된다. 여기의 기대값은 그 라우트 정의를 그대로 옮긴 것이다 — 한쪽만 바뀌면
// 이 테스트가 빨개진다.
describe("lib/api/dashboard HTTP 계약", () => {
  it("latestObservation은 GET /api/observations/latest다", async () => {
    const req = await record(() => latestObservation());
    expect(req).toEqual({ path: "/api/observations/latest", method: "GET", body: undefined });
  });

  it("observationsSince는 GET /api/observations?since=<인코딩된 ISO>다", async () => {
    const iso = "2026-08-31T00:00:00.000Z";
    const req = await record(() => observationsSince(iso));
    // since는 콜론(+)을 포함한다 — 인코딩하지 않으면 쿼리 파싱이 어긋난다.
    expect(req.path).toBe(`/api/observations?since=${encodeURIComponent(iso)}`);
    expect(req.method).toBe("GET");
  });

  it("observation은 GET /api/observations/:id다", async () => {
    const req = await record(() => observation(4321), { id: 4321 });
    expect(req).toEqual({ path: "/api/observations/4321", method: "GET", body: undefined });
  });

  it("openEvents는 GET /api/events/open이다", async () => {
    const req = await record(() => openEvents());
    expect(req).toEqual({ path: "/api/events/open", method: "GET", body: undefined });
  });

  it("criteria는 GET /api/criteria다", async () => {
    const req = await record(() => criteria());
    expect(req).toEqual({ path: "/api/criteria", method: "GET", body: undefined });
  });

  // 서버는 { rows: [...] }를 기대한다(배열을 그대로 보내면 rows가 비어 아무것도 저장되지 않는다).
  it("saveCriteria는 PUT /api/criteria에 { rows }를 보낸다", async () => {
    const rows = [{ kind: "rain" as const, grade: "watch" as const, threshold: { rain_mm_per_hr: 20 } }];
    const req = await record(() => saveCriteria(rows));
    expect(req).toEqual({ path: "/api/criteria", method: "PUT", body: { rows } });
  });

  it("siteSettings는 GET /api/site-settings다", async () => {
    const req = await record(() => siteSettings());
    expect(req).toEqual({ path: "/api/site-settings", method: "GET", body: undefined });
  });

  // site_settings는 시드 1행뿐이고 RLS가 admin에게 update만 허용한다 — 서버에
  // PUT 라우트 자체가 없어서 PUT으로 보내면 404가 된다.
  it("saveSiteSettings는 PATCH /api/site-settings에 부분 본문을 보낸다", async () => {
    const req = await record(() => saveSiteSettings({ nx: 70 }), { id: 1 });
    expect(req).toEqual({ path: "/api/site-settings", method: "PATCH", body: { nx: 70 } });
  });

  it("heartbeat는 GET /api/heartbeats/:name이다", async () => {
    const req = await record(() => heartbeat("weather-tick"), { name: "weather-tick" });
    expect(req).toEqual({ path: "/api/heartbeats/weather-tick", method: "GET", body: undefined });
  });
});
