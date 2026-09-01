import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";

// 실제 빌드 산출물(apps/web/dist)은 gitignore 대상이라 저장소에 없다. 여기서
// 검증할 것은 화면 내용이 아니라 "라우터 등록 순서"뿐이므로, index.html 하나와
// 자산 파일 하나만 담은 임시 디렉터리를 WEB_ROOT로 준다.
//
// src/index.ts는 임포트되는 순간 WEB_ROOT를 읽어 express.static을 등록한다.
// 그래서 정적 import(파일 맨 위로 끌어올려진다)가 아니라 await import를 쓴다 —
// 환경변수를 먼저 세팅해야 하기 때문이다. vitest는 테스트 파일마다 모듈 그래프를
// 격리하므로 여기서 세팅한 WEB_ROOT가 다른 테스트 파일로 새지 않는다.
const webRoot = mkdtempSync(join(tmpdir(), "weather-webroot-"));
const indexHtml = join(webRoot, "index.html");
const INDEX_BODY = "<!doctype html><title>날씨경영</title><div id=root></div>";
writeFileSync(indexHtml, INDEX_BODY);
mkdirSync(join(webRoot, "assets"));
writeFileSync(join(webRoot, "assets", "app.js"), "console.log('빌드된 번들')");
process.env.WEB_ROOT = webRoot;

const { app, SPA_FALLBACK } = await import("../src/index.ts");
const { withService } = await import("../src/db.ts");

describe("화면 서빙", () => {
  // 화면 전환이 브라우저에서 일어나므로, /criteria에서 새로고침하면
  // 서버는 그런 파일이 없다고 404를 준다. index.html로 넘겨야 한다.
  it("알 수 없는 경로는 index.html로 넘긴다", async () => {
    const res = await request(app).get("/criteria");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("id=root");
  });

  // 루트가 200 화면이어야 한다는 계약을 고정한다. 지금은 express.static이
  // index.html을 기본 파일로 내주는 단계에서 걸리고, 정적 서빙이 빠지면 SPA
  // 폴백이 대신 받아야 한다 — 어느 경로로 오든 로그인 화면은 떠야 한다.
  // (그래서 이 테스트만으로는 "/{*splat}" vs "/*splat"이 갈리지 않는다.
  //  그 한 글자는 아래 "SPA 폴백 패턴" 블록이 따로 고정한다.)
  it("루트 경로도 index.html을 준다", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("id=root");
  });

  // 실제 API가 정적 서빙에 가려지지 않는지 — /api 폴백이나 express.static이
  // 기능 라우터보다 앞으로 올라가면 여기서 걸린다.
  it("있는 API 경로는 그대로 동작한다", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // express.static이 SPA 폴백보다 뒤로 밀리면 js/css 요청까지 index.html을
  // 200으로 받는다 — 화면이 통째로 빈 채 뜨고 콘솔에만 문법 오류가 남는다.
  it("실제로 있는 자산 파일은 index.html이 아니라 그 파일을 준다", async () => {
    const res = await request(app).get("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("빌드된 번들");
    expect(res.text).not.toContain("<!doctype html>");
  });
});

// SPA 폴백이 /api에까지 걸리면, 없는 엔드포인트가 200 HTML을 돌려줘
// 클라이언트가 JSON 파싱에서 엉뚱하게 터진다(lib/api/client.ts는 2xx면
// 곧바로 res.json()을 부른다). 그래서 /api 404 폴백이 정적 서빙보다 앞에 있다.
describe("없는 API 경로", () => {
  const ACCOUNT = {
    email: "static-fallback@gonjiam.com",
    password: "correct-horse-battery",
    name: "정적서빙테스트",
  };
  let cookie = "";

  // 로그인한 요청이어야 이 폴백까지 닿는다 — dashboard/org/content 라우터가
  // 전부 /api에 requireAuth를 걸어 두어서, 비로그인 요청은 경로가 있든 없든
  // 그 앞에서 401로 끊긴다(아래에서 따로 확인한다).
  beforeAll(async () => {
    await request(app).post("/api/auth/signup").send(ACCOUNT);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: ACCOUNT.email, password: ACCOUNT.password });
    expect(login.status).toBe(200);
    cookie = login.headers["set-cookie"]?.[0] ?? "";
  });

  // 이 테스트가 만든 계정·직원 행만 지운다. 시드 데이터는 건드리지 않는다.
  afterAll(async () => {
    await withService(async (q) => {
      await q.query("delete from employees where email = $1", [ACCOUNT.email]);
      await q.query("delete from auth_accounts where email = $1", [ACCOUNT.email]);
    });
  });

  it("로그인한 요청에는 404 JSON을 준다 (index.html이 아니다)", async () => {
    const res = await request(app).get("/api/nope").set("Cookie", cookie);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.text).not.toContain("<!doctype html>");
  });

  // 비로그인 요청은 requireAuth가 먼저 끊는다. 404까지 가지 않지만, 여기서도
  // 200 HTML이 나가면 안 된다는 점은 같다.
  it("비로그인 요청에는 401 JSON을 준다", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});

// 에러 핸들러(인자 4개짜리)가 정적 서빙보다 뒤에 등록돼 있어야만 정적/SPA
// 단계에서 난 오류를 잡는다. 앞으로 옮기면 Express 기본 핸들러로 새어
// 스택트레이스와 서버 내부 경로가 담긴 HTML이 그대로 응답에 실린다.
describe("정적 단계의 오류도 에러 핸들러가 잡는다", () => {
  beforeAll(() => rmSync(indexHtml));
  afterAll(() => writeFileSync(indexHtml, INDEX_BODY));

  it("index.html이 없어도 HTML 스택트레이스를 흘리지 않는다", async () => {
    const res = await request(app).get("/criteria");
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/ENOENT|<pre>|at .*\.ts:/);
  });
});

// 실제 app에서는 express.static이 / 에 index.html을 먼저 내주기 때문에, SPA
// 폴백 패턴에서 {}를 지워 "/*splat"으로 바꿔도 위 테스트가 전부 통과한다(변이
// 확인함). 그 한 글자를 단독으로 고정하려면 정적 서빙이 없는 곳에서 패턴만
// 시험해야 한다 — 라우트가 이것 하나뿐인 빈 express 앱을 만들어 GET / 를 건다.
//
// 왜 중요한가: 정적 서빙이 어떤 이유로든(WEB_ROOT 오설정, 빌드 산출물 누락)
// / 를 못 내주는 순간 폴백이 마지막 방어선이 되는데, "/*splat"은 루트를 매치하지
// 않아 그 자리에서 404가 난다. 사내에서 주소를 치고 들어오는 첫 화면이 그 경로다.
describe("SPA 폴백 패턴", () => {
  it("패턴 하나만 등록해도 루트 경로가 폴백에 걸린다", async () => {
    const bare = express();
    bare.get(SPA_FALLBACK, (_req, res) => {
      res.type("html").send(INDEX_BODY);
    });
    const res = await request(bare).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("id=root");
  });

  it("하위 경로도 같은 패턴 하나로 받는다", async () => {
    const bare = express();
    bare.get(SPA_FALLBACK, (_req, res) => {
      res.type("html").send(INDEX_BODY);
    });
    for (const p of ["/criteria", "/events/abc/detail"]) {
      const res = await request(bare).get(p);
      expect(res.status).toBe(200);
      expect(res.text).toContain("id=root");
    }
  });
});
