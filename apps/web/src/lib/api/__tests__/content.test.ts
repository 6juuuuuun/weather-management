import { describe, expect, it, beforeEach, vi } from "vitest";
import { record } from "./contract";
import { guidelines, saveGuidelines, messagesOf, saveDraftMessage, dispatches } from "../content";

beforeEach(() => vi.restoreAllMocks());

// 대응하는 서버 라우트는 server/src/api/content.ts에 있다.
describe("lib/api/content HTTP 계약", () => {
  it("guidelines는 GET /api/guidelines다", async () => {
    const req = await record(() => guidelines());
    expect(req).toEqual({ path: "/api/guidelines", method: "GET", body: undefined });
  });

  it("saveGuidelines는 PUT /api/guidelines에 { rows }를 보낸다", async () => {
    const rows = [
      {
        department_id: "d1",
        kind: "rain" as const,
        grade: "watch" as const,
        staff_actions: ["배수구 점검"],
        guest_notice: "우천 안내",
      },
    ];
    const req = await record(() => saveGuidelines(rows), null);
    expect(req).toEqual({ path: "/api/guidelines", method: "PUT", body: { rows } });
  });

  // 서버는 event_id를 쿼리로 받는다(경로 세그먼트가 아니다).
  it("messagesOf는 GET /api/messages?event_id=<인코딩>이다", async () => {
    const req = await record(() => messagesOf("ev-1"));
    expect(req).toEqual({ path: "/api/messages?event_id=ev-1", method: "GET", body: undefined });
  });

  it("saveDraftMessage는 PATCH /api/messages/:id에 { content }를 보낸다", async () => {
    const content = [
      { department_id: "d1", department_name: "시설", selected: true, staff_actions: [], recipients: [] },
    ] as any;
    const req = await record(() => saveDraftMessage("m1", content), { id: "m1" });
    expect(req).toEqual({ path: "/api/messages/m1", method: "PATCH", body: { content } });
  });

  it("dispatches는 인자가 없으면 GET /api/dispatches다 (빈 쿼리 문자열을 붙이지 않는다)", async () => {
    const req = await record(() => dispatches());
    expect(req).toEqual({ path: "/api/dispatches", method: "GET", body: undefined });
  });

  it("dispatches는 limit·since·include_test를 쿼리로 보낸다", async () => {
    const since = "2026-08-31T00:00:00.000Z";
    const req = await record(() => dispatches({ limit: 5, since, includeTest: true }));
    const url = new URL(req.path, "http://x");
    expect(url.pathname).toBe("/api/dispatches");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("since")).toBe(since);
    expect(url.searchParams.get("include_test")).toBe("true");
  });

  // include_test를 안 보내는 것이 "테스트 발송 제외"의 기본값이다(History.tsx의
  // 예전 .eq("is_test", false)와 같다). false를 명시적으로 보내면 서버가 문자열
  // "false"를 받게 되는데, 그건 이 옵션이 켜졌다는 뜻이 아니어야 한다.
  it("dispatches는 includeTest가 false면 include_test를 아예 보내지 않는다", async () => {
    const req = await record(() => dispatches({ includeTest: false }));
    expect(req.path).toBe("/api/dispatches");
  });
});
