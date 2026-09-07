import express from "express";
import path from "node:path";
import cookieParser from "cookie-parser";
import { authRouter, adminUserRouter } from "./auth/routes.ts";
import { dashboardRouter } from "./api/dashboard.ts";
import { orgRouter } from "./api/org.ts";
import { contentRouter } from "./api/content.ts";
import { forecastRouter } from "./api/forecast.ts";
import { requireAuth } from "./auth/middleware.ts";
import { allowedDomains } from "./auth/emailDomain.ts";
import { withService } from "./db.ts";
import { runSend } from "./jobs/send.ts";
import { startScheduler } from "./jobs/scheduler.ts";
import { checkHealth } from "./jobs/watchdog.ts";

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// /api/health는 "프로세스가 응답하는가"만 본다 — DB가 죽어도, 수집이 몇 시간째
// 멈춰 있어도 200이다(docker의 healthcheck가 그걸 본다). 운영자가 "정말 잘 돌고
// 있나"를 확인할 때 볼 곳은 이쪽이다. 문제가 있으면 상태 코드까지 503으로
// 바뀌므로 사내 모니터링에서 그대로 걸어 쓸 수 있다.
// 로그인을 요구하지 않는다 — 로그인이 안 되는 상황을 확인하려고 부르는
// 엔드포인트라 인증을 걸면 쓸모가 없다. 응답에 담기는 것은 "수집이 멈췄다"
// 같은 상태 문장뿐이라 새어 나갈 개인정보가 없다. 아래 라우터들보다 반드시
// 앞에 있어야 한다 — 뒤로 밀리면 requireAuth가 먼저 401로 끊는다.
app.get("/api/health/deep", async (_req, res) => {
  const h = await checkHealth();
  res.status(h.ok ? 200 : 503).json(h);
});

// 가입 화면(로그인 전)이 부서 드롭다운을 채우는 데 쓰는 유일한 공개 조회다.
// /api/departments는 orgRouter 안에 있고 orgRouter는 통째로 requireAuth라, 가입하려는
// 사람은 그 목록을 절대 받을 수 없었다 — 화면은 "부서 목록을 불러오지 못했습니다"만
// 띄우고 모두가 부서 없이 가입하게 되고, 그러면 requireDepartment가 지키는
// /criteria·/guidelines·/events/:id가 통째로 막힌다. 실제 브라우저에서 재현했다.
//
// 인증 라우터들보다 **앞에** 둔다. 뒤로 밀리면 orgRouter의 requireAuth가 먼저 401로 끊는다.
// 내보내는 값은 id와 이름뿐이다 — 조직도의 다른 정보(상위 부서·수신자 설정 등)는
// 로그인한 뒤 /api/departments로만 나간다.
app.get("/api/public/departments", async (_req, res) => {
  const rows = await withService(async (q) => {
    const { rows } = await q.query("select id, name from departments order by name");
    return rows;
  });
  res.json(rows);
});

// 가입 화면이 "회사 이메일 도메인이 하나로 정해져 있는가"를 묻는 자리다.
//
// 왜 /api/public/*인가: 이 화면은 **로그인 전**에 그려진다. 같은 값을 이미 내보내는
// 통로가 하나 있지만(GET /api/notify-channel — dashboardRouter, requireAdmin) 그
// 경로는 인증을 요구하므로 가입하려는 사람은 401만 받는다. 바로 위 부서 드롭다운이
// 정확히 같은 이유로 /api/public/departments가 되었고, 이것도 같은 선례를 따른다.
// 인증 라우터들보다 **앞에** 두어야 하는 이유도 같다.
//
// 도메인 목록은 이 서버가 이미 가입 실패 문구로 사실상 공개하고 있고, 화면에
// 그대로 보여 주는 것이 이 기능의 목적이므로 로그인 전에 나가도 새로 새는 정보가
// 없다. env만 읽으므로 DB에 닿지 않는다.
//
// 화면 규칙(apps/web/src/pages/Signup.tsx):
//   도메인이 정확히 1개 → 아이디 칸 + 고정 도메인으로 나눠 그린다
//   비었거나 2개 이상   → 지금과 같은 자유 입력 한 칸
// 그래서 서비스 시작 때 .env의 ALLOWED_EMAIL_DOMAINS 한 줄과 재시작만으로 켜진다.
app.get("/api/public/signup-config", (_req, res) => {
  res.json({ email_domains: allowedDomains() });
});

app.use("/api/auth", authRouter);
app.use("/api/admin/users", adminUserRouter);
app.use("/api", dashboardRouter);
app.use("/api", orgRouter);
app.use("/api", contentRouter);
app.use("/api", forecastRouter);

// 화면이 부르던 Edge Function invoke("send")를 대신한다(이관 전 구조).
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

// 라우터 등록 순서: 기능 라우터 → /api 404 폴백 → 정적 서빙 → SPA 폴백 → 에러 핸들러.
// 이 순서는 기능이다. 폴백이 라우터보다 앞서면 그 라우터는 조용히 404가 나고,
// 정적 폴백이 /api 폴백보다 앞서면 없는 엔드포인트가 200 index.html을 돌려준다.
// 에러 핸들러(맨 아래, 인자 4개짜리)는 반드시 이 목록의 가장 마지막에 등록돼야
// 한다 — Express는 등록 순서상 자기보다 앞에 있는 미들웨어·라우터의 에러만
// 잡는다. 아래 정적 서빙도 그래서 에러 핸들러 앞에 있다.
// server/test/static.test.ts가 이 순서를 양방향으로 고정한다.

// Cloudflare(지운 apps/web/wrangler.jsonc)가 하던 정적 서빙을 앱이 가져온다. 화면과
// API가 같은 오리진에서 나가므로 lib/api/client.ts의 상대경로 fetch와 세션 쿠키가
// 그대로 동작하고, 배포는 컨테이너 2개(앱 + Postgres)로 끝난다.
// WEB_ROOT는 이미지에서 /app/public(빌드된 apps/web/dist)으로 주입된다.
const webRoot = process.env.WEB_ROOT ?? path.resolve("public");

// /api 404 폴백이 정적 서빙보다 반드시 먼저다. 뒤로 밀리면 없는 엔드포인트가
// 아래 SPA 폴백에 걸려 200 index.html을 받고, client.ts가 그걸 res.json()으로
// 파싱하다 엉뚱한 곳에서 터진다 — 진짜 원인(오타 난 경로)이 완전히 가려진다.
app.use("/api", (_req, res) => res.status(404).json({ error: "없는 경로입니다" }));

app.use(express.static(webRoot));

// SPA 폴백 경로 패턴. 상수로 빼 둔 이유는 test/static.test.ts가 이 값 자체를
// 가져다 "라우트가 이것 하나뿐인 빈 express 앱"에 걸고 GET /를 확인하기
// 위해서다 — 실제 app에서는 express.static이 먼저 / 에 index.html을 내주므로
// 여기서 {}를 지워 "/*splat"으로 바꿔도 어떤 테스트도 깨지지 않았다(변이 확인함).
// 상수로 노출해야만 그 한 글자를 단독으로 고정할 수 있다.
export const SPA_FALLBACK = "/{*splat}";

// 화면 전환을 react-router가 브라우저에서 하므로 /criteria 같은 경로에는 실제
// 파일이 없다. 그 경로에서 새로고침하면 404가 나므로 index.html로 넘긴다 —
// 지운 wrangler.jsonc의 not_found_handling: "single-page-application"이 하던 일이다.
//
// 패턴이 "*"가 아니라 "/{*splat}"인 이유: express@5는 path-to-regexp v8을 쓰고
// 거기서 이름 없는 "*"는 더 이상 유효한 패턴이 아니다 — 요청 처리 중이 아니라
// 라우트 "등록" 시점에 예외를 던져 서버가 아예 뜨지 않는다(실제로 확인함).
// v8 문법에서 "0개 이상의 세그먼트"는 이름 붙인 와일드카드를 선택 그룹 {}로
// 감싼 형태다. {}를 빼고 "/*splat"으로 쓰면 루트 "/"가 매치되지 않는다.
app.get(SPA_FALLBACK, (_req, res) => res.sendFile(path.join(webRoot, "index.html")));

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
  // pg_cron이 pg_net으로 앱을 호출하던 구조를 걷어냈다 — 앱이 상시 떠 있으므로
  // 안에서 스스로 주기를 돈다. vitest는 NODE_ENV를 "test"로 미리 설정해 두므로
  // (확인됨 — server/vitest.config.ts는 이 값을 건드리지 않는다) 이 가드가 테스트
  // 중에는 cron 타이머가 뜨지 않게 그대로 막아 준다. app.listen과 같은 가드를
  // 쓰는 이유: 테스트 프로세스가 계속 살아있게 만드는 것도, 테스트 DB에 실제
  // tick을 돌리는 것도 여기서 막아야 하는 문제라 정확히 같은 조건이다.
  startScheduler();
}
