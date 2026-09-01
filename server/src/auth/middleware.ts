import type { CookieOptions, NextFunction, Request, Response } from "express";
import { lookup, SESSION_COOKIE_MAX_AGE_MS, type SessionUser } from "./session.ts";

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
  }
}

export const COOKIE = "sid";

/** 로그인과 세션 연장이 **같은 옵션**으로 쿠키를 심게 한 곳에 모아 둔다.
 *  한쪽만 바뀌면 브라우저는 쿠키를 두 개로 보거나(path/domain이 다를 때)
 *  연장이 조용히 아무 효과도 내지 못한다. */
export const sessionCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.COOKIE_SECURE === "true",
  maxAge: SESSION_COOKIE_MAX_AGE_MS,
});

// must_change_password가 참인 세션이 그래도 계속 드나들 수 있어야 하는 최소한의
// 통로. 이 목록에 없는 /api/* 요청은 비밀번호를 바꾸기 전까지 전부 막는다.
// 프런트엔드 리다이렉트만으로는 브라우저를 거치지 않는 클라이언트를 막을 수
// 없어서, 강제 자체를 서버 쪽 게이트로 옮겼다.
const ALLOWED_WHILE_MUST_CHANGE: { method: string; path: string }[] = [
  { method: "POST", path: "/api/auth/change-password" },
  { method: "GET", path: "/api/auth/me" },
  { method: "POST", path: "/api/auth/logout" },
];

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다" });
  const user = await lookup(token);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다" });
  req.user = user;

  // 슬라이딩 만료: lookup이 DB의 만료 시각을 밀었으면 브라우저 쿠키의 수명도
  // 같이 민다. 이걸 빼면 DB 세션은 살아 있는데 쿠키가 먼저 죽어 사용자는
  // 그대로 로그아웃된다 — 벽걸이 월보드에는 그 차이가 보이지 않는다.
  if (user.slid) res.cookie(COOKIE, token, sessionCookieOptions());

  if (user.mustChangePassword) {
    // Express는 기본으로 경로 대소문자를 구분하지 않고 끝 슬래시도 무시한다
    // (둘 다 그대로 핸들러에 도달한다). 허용 목록 비교가 정확 일치인 채로
    // 두면, 탈출구인 change-password를 대문자나 끝 슬래시가 붙은 형태로
    // 부르는 세션이 그 탈출구에서조차 막혀 버린다. 비교 전에 같은 기준으로
    // 맞춘다.
    const path = (req.originalUrl.split("?")[0] ?? "").toLowerCase().replace(/\/+$/, "");
    const allowed = ALLOWED_WHILE_MUST_CHANGE.some((r) => r.method === req.method && r.path === path);
    if (!allowed) {
      return res.status(403).json({ error: "비밀번호를 먼저 변경해야 합니다", must_change_password: true });
    }
  }

  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "권한이 없습니다" });
  next();
}
