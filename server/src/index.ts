import express from "express";
import cookieParser from "cookie-parser";
import { authRouter, adminUserRouter } from "./auth/routes.ts";
import { dashboardRouter } from "./api/dashboard.ts";
import { orgRouter } from "./api/org.ts";

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
app.use("/api/admin/users", adminUserRouter);
app.use("/api", dashboardRouter);
app.use("/api", orgRouter);

// 라우터 등록 순서: 기능 라우터 → /api 404 폴백 → 정적 서빙.
// 이후 태스크가 기능 라우터와 정적 파일 서빙을 이 사이에 끼워 넣는다. 폴백이
// 라우터보다 앞서면 그 라우터는 조용히 404가 난다 — 순서를 여기서 미리 확정해 둔다.

const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => console.log(`[server] listening on ${port}`));
}
