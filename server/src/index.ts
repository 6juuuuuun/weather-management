import express from "express";
import cookieParser from "cookie-parser";
import { authRouter, adminUserRouter } from "./auth/routes.ts";
import { dashboardRouter } from "./api/dashboard.ts";
import { orgRouter } from "./api/org.ts";
import { contentRouter } from "./api/content.ts";
import { requireAuth } from "./auth/middleware.ts";
import { runSend } from "./jobs/send.ts";

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
app.use("/api/admin/users", adminUserRouter);
app.use("/api", dashboardRouter);
app.use("/api", orgRouter);
app.use("/api", contentRouter);

// 화면이 부르던 supabase functions.invoke("send")를 대신한다.
// 권한 검사(알림 수신자만 승인, 테스트 발송은 관리자만)는 runSend 안에 그대로 있다 —
// 여기서 다시 판정하지 않는다. 계정은 있지만 직원 행이 아직 없는 세션은 발송 주체가
// 될 수 없으므로 여기서 막는다.
// runSend는 거부 사유별 상태 코드(403 권한 / 400 잘못된 요청 / 409 상태 충돌 /
// 404 없음)를 결과에 실어 준다. 원본 Edge Function이 쓰던 코드를 그대로 유지하려고
// 그 값을 쓰고, 없으면 403으로 떨어뜨린다.
app.post("/api/send", requireAuth, async (req, res) => {
  if (!req.user!.employeeId) return res.status(403).json({ error: "직원 정보가 없습니다" });
  const out = await runSend(req.body, req.user!.employeeId);
  res.status(out.ok ? 200 : (out.status ?? 403)).json(out);
});

// 라우터 등록 순서: 기능 라우터 → /api 404 폴백 → 정적 서빙 → 에러 핸들러.
// 이후 태스크가 기능 라우터와 정적 파일 서빙을 이 사이에 끼워 넣는다. 폴백이
// 라우터보다 앞서면 그 라우터는 조용히 404가 난다 — 순서를 여기서 미리 확정해 둔다.
// 에러 핸들러(아래, 인자 4개짜리)는 반드시 이 목록의 가장 마지막에 등록돼야
// 한다 — Express는 등록 순서상 자기보다 앞에 있는 미들웨어·라우터의 에러만
// 잡는다. 뒤에 정적 서빙을 끼워 넣을 때도 에러 핸들러 앞에 넣을 것.

// 잡히지 않은 예외(예: enum에 없는 값을 그대로 바인딩해 나는 DB 오류)가
// Express 기본 핸들러로 새면 스택트레이스와 서버 내부 파일 경로가 담긴 HTML이
// 그대로 응답에 실린다 — 실제로 PUT /alert-settings에 존재하지 않는 kind를
// 보내 재현했다. 원인은 서버 로그에만 남기고, 응답은 항상 최소한의 JSON만
// 내보낸다. 4개 인자(err, req, res, next)를 받아야 Express가 이 함수를 에러
// 핸들러로 인식한다 — 3개면 그냥 무시되고 다시 기본 핸들러로 샌다.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] unhandled error", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "서버 오류가 발생했습니다" });
});

const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => console.log(`[server] listening on ${port}`));
}
