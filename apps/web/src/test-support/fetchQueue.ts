// 화면/통합 테스트가 공유하는 fetch 목 도구. lib/api/__tests__/contract.ts와 같은 이유로
// 존재한다 — 화면이 lib/api 모듈을 통째로 목하면 경로가 틀려도 초록이 나온다(Task 9
// 수정 라운드 1의 F2가 그 사례다). vi.stubGlobal("fetch", ...)로 실제 경로·메서드·본문을
// 단언하되, 경로별 호출 순서를 테스트가 직접 통제할 수 있게 FIFO 큐로 감싼다.
import { vi } from "vitest";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/**
 * 경로별 엄격한 FIFO 큐. 같은 경로가 여러 번 불리는 시나리오(예: 로그인 성공 뒤
 * AuthProvider.refresh()가 GET /api/auth/me를 다시 부름)에서, "몇 번째 호출에 어떤
 * 응답을 줄지"를 테스트가 명시적으로 정하게 한다. 응답을 미리 채워 두지 않은 경로가
 * 불리면 즉시 예외를 던진다 — 의도치 않은 추가 호출을 조용히 통과시키지 않기 위해서다.
 */
export function makeFetchQueue() {
  const queues = new Map<string, (() => Response)[]>();
  const push = (path: string, make: () => Response) => {
    const q = queues.get(path) ?? [];
    q.push(make);
    queues.set(path, q);
  };
  // 두 번째 인자(init)를 시그니처에 남겨 둔다 — 실제로는 여기서 쓰지 않지만, 이걸
  // 빼면 vi.fn()의 추론 타입이 [path: string] 1튜플이 되어 호출부가 mock.calls에서
  // init(예: JSON.stringify된 body)을 꺼내 쓸 때마다 타입 에러가 난다.
  const fetchMock = vi.fn((path: string, _init?: RequestInit) => {
    const q = queues.get(path);
    if (!q || q.length === 0) throw new Error(`no mock response queued for ${path}`);
    return Promise.resolve(q.shift()!());
  });
  return { fetchMock, push };
}
