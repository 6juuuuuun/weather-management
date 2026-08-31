import { describe, expect, it, beforeEach, vi } from "vitest";
import { record } from "./contract";
import { callSend } from "../send";
import type { DeptBlock } from "../../types";

beforeEach(() => vi.restoreAllMocks());

const content: DeptBlock[] = [
  {
    department_id: "d1",
    department_name: "객실",
    staff_actions: ["수건 2개 배포"],
    guest_notice: "안내문",
    recipients: [{ employee_id: "e1", name: "홍수진", kakaowork_user_id: "kw1" }],
    selected: true,
  },
];

// 대응하는 서버 라우트는 server/src/index.ts의 app.post("/api/send", ...)이고
// 실제 처리는 server/src/jobs/send.ts의 runSend다. 여기 기대값은 그 라우트를 그대로
// 옮긴 것이다 — 한쪽만 바뀌면 이 테스트가 빨개진다. (예전에는 supabase의
// functions.invoke("send")를 불렀다. 그 시절엔 경로·메서드를 못 박는 테스트가 없었다.)
describe("lib/api/send HTTP 계약", () => {
  it("승인은 POST /api/send에 { mode, event_id, content }를 보낸다", async () => {
    const req = await record(() => callSend({ mode: "approve", event_id: "ev-1", content }), { ok: true });
    expect(req).toEqual({
      path: "/api/send",
      method: "POST",
      body: { mode: "approve", event_id: "ev-1", content },
    });
  });

  it("재발송은 event_id가 아니라 message_id를 보낸다", async () => {
    const req = await record(() => callSend({ mode: "resend", message_id: "msg-1", content }), { ok: true });
    // 서버는 resend에서 message_id로 messages를 갱신한다 — event_id를 보내면 아무것도 안 걸린다.
    expect(req).toEqual({
      path: "/api/send",
      method: "POST",
      body: { mode: "resend", message_id: "msg-1", content },
    });
  });

  it("무시는 POST /api/send에 { mode, event_id }만 보낸다", async () => {
    const req = await record(() => callSend({ mode: "dismiss", event_id: "ev-1" }), { ok: true });
    expect(req).toEqual({ path: "/api/send", method: "POST", body: { mode: "dismiss", event_id: "ev-1" } });
  });

  it("테스트 발송은 POST /api/send에 { mode: 'test' }만 보낸다", async () => {
    const req = await record(() => callSend({ mode: "test" }), { ok: true });
    expect(req).toEqual({ path: "/api/send", method: "POST", body: { mode: "test" } });
  });

  it("서버 응답 본문을 그대로 돌려준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, dispatch_id: 7, fail_count: 2 }), { status: 200 })),
    );
    await expect(callSend({ mode: "test" })).resolves.toEqual({ ok: true, dispatch_id: 7, fail_count: 2 });
  });

  // 권한 거부(403)는 supabase-js 시절처럼 resolve되지 않는다 — 호출부가 catch하지
  // 않으면 로딩 상태가 영영 풀리지 않는다.
  it("HTTP 오류에는 서버 메시지를 담아 throw한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "권한이 없습니다" }), { status: 403 })),
    );
    await expect(callSend({ mode: "dismiss", event_id: "ev-1" })).rejects.toMatchObject({
      status: 403,
      message: "권한이 없습니다",
    });
  });
});
