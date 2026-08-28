import type { NextFunction, Request, Response } from "express";
import { lookup, type SessionUser } from "./session.ts";

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
  }
}

export const COOKIE = "sid";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다" });
  const user = await lookup(token);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다" });
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "권한이 없습니다" });
  next();
}
