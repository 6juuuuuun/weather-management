import type { NextFunction, Request, Response } from "express";
import { lookup, type SessionUser } from "./session.ts";

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
  }
}

export const COOKIE = "sid";

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

  if (user.mustChangePassword) {
    const path = req.originalUrl.split("?")[0];
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
