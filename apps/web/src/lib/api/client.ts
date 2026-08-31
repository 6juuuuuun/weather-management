// 서버와 이야기하는 유일한 통로. 화면은 이 파일과 resource별 모듈(dashboard/org/content)만
// 알면 되고, 엔드포인트 경로·에러 모양이 바뀌어도 여기만 고치면 된다.

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
    try {
      const j = await res.json();
      if (j?.error) message = j.error;
    } catch {
      /* 본문이 JSON이 아니면(예: 라우트가 아예 없어 기본 404 HTML을 돌려줄 때) 기본 문구를 쓴다 */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string) => call<T>("GET", path);
export const apiSend = <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) =>
  call<T>(method, path, body);
