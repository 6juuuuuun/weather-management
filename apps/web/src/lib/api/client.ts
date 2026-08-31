// 서버와 이야기하는 유일한 통로. 화면은 이 파일과 resource별 모듈(dashboard/org/content)만
// 알면 되고, 엔드포인트 경로·에러 모양이 바뀌어도 여기만 고치면 된다.

export class ApiError extends Error {
  readonly status: number;
  // 파싱된 응답 본문 전체. 상태 코드만으로는 갈리지 않는 경우가 있어서 남긴다 —
  // auth/middleware.ts는 "비밀번호 강제 변경" 상태에서 모든 /api/* 요청에
  // 403 { must_change_password: true }를 주는데, requireAdmin의 권한 거부도 403이다.
  // 이 플래그가 없으면 로그인 화면이 둘을 한국어 메시지 문자열로 구분할 수밖에 없고,
  // 문구 한 글자만 바뀌어도 깨진다. 본문이 JSON이 아니면 null이다.
  readonly body: Record<string, unknown> | null;
  constructor(status: number, message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // 세션이 httpOnly 쿠키에 있다. 이걸 빼면 로그인해도 모든 요청이 401로 떨어진다.
    credentials: "include",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `요청이 실패했습니다 (${res.status})`;
    let parsed: Record<string, unknown> | null = null;
    try {
      const j = await res.json();
      if (j && typeof j === "object" && !Array.isArray(j)) parsed = j as Record<string, unknown>;
      if (j?.error) message = j.error;
    } catch {
      /* 본문이 JSON이 아니면(예: 라우트가 아예 없어 기본 404 HTML을 돌려줄 때) 기본 문구를 쓴다 */
    }
    throw new ApiError(res.status, message, parsed);
  }

  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string) => call<T>("GET", path);
export const apiSend = <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) =>
  call<T>(method, path, body);
