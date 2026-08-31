// lib/api 모듈들의 HTTP 계약 테스트가 공유하는 도구.
//
// 화면 테스트는 vi.mock("../lib/api/dashboard", ...)처럼 이 모듈들을 통째로 목한다 —
// 그래서 경로·메서드·본문이 틀려도 화면 테스트는 전부 통과한다. 서버 라우트를
// 건드리지 않고 클라이언트 경로만 틀리게 바꿨을 때 빨개지는 건 이 테스트들뿐이다.
import { expect, vi } from "vitest";

export type Recorded = { path: string; method: string; body: unknown };

/**
 * fetch를 목으로 갈아 끼우고, 호출된 요청 1건을 그대로 돌려준다.
 * 본문은 client.ts가 JSON.stringify한 문자열이므로 다시 파싱해서 비교하기 쉽게 만든다
 * (문자열로 비교하면 키 순서에 묶여 의미 없는 실패가 난다).
 */
export async function record(run: () => Promise<unknown>, response?: unknown): Promise<Recorded> {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(response ?? []), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await run();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0];
  return {
    path: String(path),
    method: init.method,
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  };
}
