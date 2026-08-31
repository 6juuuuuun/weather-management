import { describe, expect, it, vi, beforeEach } from "vitest";
import { apiGet, apiSend } from "../client";

beforeEach(() => vi.restoreAllMocks());

describe("API 클라이언트", () => {
  // 세션이 httpOnly 쿠키에 있으므로 요청에 쿠키가 실려야 한다.
  // credentials를 빼면 로그인해도 모든 요청이 401로 떨어진다.
  it("항상 쿠키를 함께 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/departments");
    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  });

  it("실패하면 상태 코드를 담은 ApiError를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "권한이 없습니다" }), { status: 403 })),
    );
    await expect(apiGet("/api/departments")).rejects.toMatchObject({
      status: 403,
      message: "권한이 없습니다",
    });
  });

  it("본문이 없는 204에도 터지지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiSend("PUT", "/api/guidelines", { rows: [] })).resolves.toBeNull();
  });

  // 실패 응답이 JSON이 아닐 수 있다(라우트가 아예 없어 Express 기본 404 HTML이 오는 경우 등).
  // 이때도 파싱 예외로 죽지 않고 기본 문구로 ApiError를 던져야 한다.
  it("에러 본문이 JSON이 아니면 기본 문구를 쓴다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Not Found</html>", { status: 404 })));
    await expect(apiGet("/api/nope")).rejects.toMatchObject({
      status: 404,
      message: "요청이 실패했습니다 (404)",
    });
  });

  // body가 있는 요청에는 Content-Type과 JSON 직렬화된 본문이 실려야 한다 —
  // 둘 중 하나라도 빠지면 서버(express.json())가 body를 파싱하지 못해 req.body가 비어버린다.
  it("본문이 있는 요청은 JSON으로 직렬화해 Content-Type과 함께 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiSend("PATCH", "/api/employees/e1", { name: "홍길동" });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/employees/e1");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ name: "홍길동" }));
  });

  // 본문 없는 GET은 Content-Type을 보내지 않는다 — 실려도 무해하지만, 있으면
  // "본문 유무로 헤더를 분기한다"는 의도가 깨졌다는 신호다.
  it("본문이 없는 GET은 Content-Type을 보내지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/departments");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers).toEqual({});
    expect(init.body).toBeUndefined();
  });
});
