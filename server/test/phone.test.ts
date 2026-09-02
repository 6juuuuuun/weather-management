import { describe, expect, it, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";
import { normalizePhone } from "../src/phone.ts";

// employees.phone을 채우는 쓰기 경로는 셋이고(가입 · 사전 등록 · 직원 수정),
// 이 파일은 **그 셋을 한자리에서** 본다. 이 저장소는 "한 경로에만 걸린 규칙"으로
// 이미 두 번 다쳤다(이메일 도메인 · 이메일 형식) — 규칙이 형제 경로에서 갈라지면
// 느슨한 쪽으로 들어온 값이 나머지 경로의 전제를 깬다. 파일을 나누면 새 쓰기
// 경로가 생겼을 때 "여기에도 추가해야 한다"는 신호가 사라진다.

const PREFIX = "zzphone-";
const PASSWORD = "correct-horse-battery";

async function cleanup() {
  await withService(async (q) => {
    await q.query("delete from employees where email like $1", [`${PREFIX}%`]);
    await q.query("delete from auth_accounts where email like $1", [`${PREFIX}%`]);
  });
}

beforeEach(cleanup);
afterAll(cleanup);

async function adminAgent(email: string) {
  await request(app).post("/api/auth/signup").send({ email, password: PASSWORD, name: "관리자" });
  await withService((q) => q.query("update employees set role='admin' where email=$1", [email]));
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password: PASSWORD });
  return agent;
}

const phoneOf = (email: string) =>
  withService(async (q) => {
    const { rows } = await q.query("select phone from employees where email = $1", [email]);
    return rows.length === 0 ? undefined : (rows[0].phone as string | null);
  });

// 한 곳에서만 정의한다 — 아래 세 경로가 **같은 값들**로 검사받아야 "규칙이 하나"라는
// 말이 검증된다. 경로마다 다른 예시를 쓰면 한쪽만 느슨해도 초록이 나온다.
const PASTED: [string, string][] = [
  ["01012345678", "010-1234-5678"],
  ["010 1234 5678", "010-1234-5678"],
  ["010.1234.5678", "010-1234-5678"],
  ["  010-1234-5678  ", "010-1234-5678"],
  ["0111234567", "011-123-4567"], // 구 번호대는 10자리도 있다
  ["01112345678", "011-1234-5678"],
];

const REJECTED = [
  "02-123-4567", // 유선번호는 범위 밖이다(입력란 이름이 "휴대폰 번호")
  "0101234567", // 010은 11자리여야 한다
  "010-1234-56789", // 12자리
  "010-1234-567a",
  "abc",
  "+82 10 1234 5678", // 국제 표기는 받지 않는다
  "010--1234-5678999999",
];

describe("휴대폰 번호 규칙 (src/phone.ts)", () => {
  it("붙여넣은 여러 모양을 하나의 정규형으로 만든다", () => {
    for (const [raw, want] of PASTED) {
      expect(normalizePhone(raw), raw).toEqual({ ok: true, phone: want });
    }
  });

  it("휴대폰이 아닌 값은 거절한다", () => {
    for (const raw of REJECTED) {
      expect(normalizePhone(raw), raw).toEqual({ ok: false });
    }
  });

  // 전화번호는 지금도 선택 입력이다. 여기서 필수로 바꾸면 번호 없이 등록된 직원의
  // 이름만 고치려는 저장까지 막힌다.
  it("빈 값과 미입력은 그대로 허용한다(선택 항목)", () => {
    expect(normalizePhone(null)).toEqual({ ok: true, phone: null });
    expect(normalizePhone(undefined)).toEqual({ ok: true, phone: null });
    expect(normalizePhone("")).toEqual({ ok: true, phone: null });
    expect(normalizePhone("   ")).toEqual({ ok: true, phone: null });
  });

  // 세 경로 모두 검증되지 않은 JSON 본문에서 값을 꺼낸다 — 문자열이 아닌 값이
  // String()으로 뭉개져 우연히 통과하는 자리를 만들지 않는다.
  it("문자열이 아닌 값은 거절한다", () => {
    expect(normalizePhone(1012345678)).toEqual({ ok: false });
    expect(normalizePhone(["010", "1234", "5678"])).toEqual({ ok: false });
    expect(normalizePhone({})).toEqual({ ok: false });
  });
});

describe("가입(POST /api/auth/signup)의 전화번호", () => {
  it("공백이 든 붙여넣기도 정규형으로 저장한다", async () => {
    const email = `${PREFIX}signup-ok@gonjiam.com`;
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: PASSWORD, name: "홍길동", phone: "010 1234 5678" });
    expect(res.status).toBe(201);
    expect(await phoneOf(email)).toBe("010-1234-5678");
  });

  it("휴대폰이 아닌 번호는 400이고 계정도 직원 행도 만들어지지 않는다", async () => {
    const email = `${PREFIX}signup-bad@gonjiam.com`;
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: PASSWORD, name: "홍길동", phone: "02-123-4567" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/휴대폰 번호/);
    expect(await phoneOf(email)).toBeUndefined();
    // 브라우저를 거치지 않는 요청이라 화면의 서식은 방벽이 아니다 — 실제로
    // 로그인까지 되지 않는지 본다.
    const login = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it("전화번호를 비워도 가입된다", async () => {
    const email = `${PREFIX}signup-none@gonjiam.com`;
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: PASSWORD, name: "홍길동" });
    expect(res.status).toBe(201);
    expect(await phoneOf(email)).toBeNull();
  });
});

describe("사전 등록(POST /api/employees)의 전화번호", () => {
  // 회귀: 예전에는 insert 목록에 phone이 없어서 본문에 실어도 **말없이 버려졌다.**
  // 관리자는 입력했다고 믿고, 그 직원은 비상 연락처 없이 명부에 앉는다.
  it("보낸 번호를 정규형으로 실제 저장한다", async () => {
    const agent = await adminAgent(`${PREFIX}admin1@gonjiam.com`);
    const email = `${PREFIX}pre-ok@gonjiam.com`;
    const res = await agent.post("/api/employees").send({ name: "사전등록", email, phone: "01012345678" });
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe("010-1234-5678");
    expect(await phoneOf(email)).toBe("010-1234-5678");
  });

  it("휴대폰이 아닌 번호는 400이고 직원 행이 만들어지지 않는다", async () => {
    const agent = await adminAgent(`${PREFIX}admin2@gonjiam.com`);
    const email = `${PREFIX}pre-bad@gonjiam.com`;
    const res = await agent.post("/api/employees").send({ name: "사전등록", email, phone: "02-123-4567" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/휴대폰 번호/);
    expect(await phoneOf(email)).toBeUndefined();
  });
});

describe("직원 수정(PATCH /api/employees/:id)의 전화번호", () => {
  async function seedEmployee(agent: ReturnType<typeof request.agent>, email: string, phone: string | null) {
    const created = await agent.post("/api/employees").send({ name: "대상", email });
    if (phone !== null) {
      // 옛 규칙으로 들어온 값을 흉내 내려면 API를 거치면 안 된다 — 지금은 API가
      // 그 값을 막는 것이 정상이다.
      await withService((q) => q.query("update employees set phone=$2 where id=$1", [created.body.id, phone]));
    }
    return created.body.id as string;
  }

  it("보낸 번호를 정규형으로 저장한다", async () => {
    const agent = await adminAgent(`${PREFIX}admin3@gonjiam.com`);
    const email = `${PREFIX}patch-ok@gonjiam.com`;
    const id = await seedEmployee(agent, email, null);
    const res = await agent.patch(`/api/employees/${id}`).send({ phone: "010 1234 5678" });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe("010-1234-5678");
    expect(await phoneOf(email)).toBe("010-1234-5678");
  });

  it("휴대폰이 아닌 번호는 400이고 옛 값이 그대로 남는다", async () => {
    const agent = await adminAgent(`${PREFIX}admin4@gonjiam.com`);
    const email = `${PREFIX}patch-bad@gonjiam.com`;
    const id = await seedEmployee(agent, email, "010-9999-9999");
    const res = await agent.patch(`/api/employees/${id}`).send({ phone: "02-123-4567" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/휴대폰 번호/);
    expect(await phoneOf(email)).toBe("010-9999-9999");
  });

  it("빈 문자열은 '지운다'는 뜻으로 받는다", async () => {
    const agent = await adminAgent(`${PREFIX}admin5@gonjiam.com`);
    const email = `${PREFIX}patch-clear@gonjiam.com`;
    const id = await seedEmployee(agent, email, "010-9999-9999");
    const res = await agent.patch(`/api/employees/${id}`).send({ phone: "" });
    expect(res.status).toBe(200);
    expect(await phoneOf(email)).toBeNull();
  });

  // **이미 저장된 값은 건드리지 않는다.** 규칙이 생기기 전에 들어온 번호(유선·내선
  // 등)를 가진 직원이 실제로 있을 수 있다. 그 사람의 역할만 바꾸려는 저장까지
  // 400으로 막히면, 관리자는 자기가 건드리지도 않은 칸을 "고쳐야" 저장할 수 있게 된다.
  it("본문에 phone이 없으면 옛 규칙으로 저장된 값을 검사하지도, 지우지도 않는다", async () => {
    const agent = await adminAgent(`${PREFIX}admin6@gonjiam.com`);
    const email = `${PREFIX}patch-legacy@gonjiam.com`;
    const id = await seedEmployee(agent, email, "02) 123-4567 (내선 8)");
    const res = await agent.patch(`/api/employees/${id}`).send({ role: "approver" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("approver");
    expect(await phoneOf(email)).toBe("02) 123-4567 (내선 8)");
    // 조회도 그대로 보여야 한다 — 규칙은 새 쓰기에만 건다.
    expect(res.body.phone).toBe("02) 123-4567 (내선 8)");
  });
});

// 이 파일의 핵심. 위 세 describe가 각각 초록이어도, 세 경로가 **같은** 값 집합에
// 대해 같은 판정을 내리는지는 따로 묶어야 드러난다 — 한 경로만 규칙을 잃거나
// (예: import를 지우고 통과시키거나) 자기만의 느슨한 검사를 갖게 되는 회귀를 잡는다.
describe("세 쓰기 경로가 같은 규칙을 쓴다", () => {
  it("같은 값을 가입·사전 등록·직원 수정이 모두 같게 판정한다", async () => {
    const agent = await adminAgent(`${PREFIX}admin7@gonjiam.com`);
    const target = await agent.post("/api/employees").send({ name: "대상", email: `${PREFIX}shared@gonjiam.com` });
    const targetId = target.body.id as string;
    let n = 0;

    // 값을 몇 개로 줄인다 — 전체 표는 위 단위 테스트가 이미 본다. 여기서 지켜야
    // 하는 것은 "세 경로가 그 표를 **같이** 쓰는가"이고, 그건 대표값 몇 개로
    // 충분히 드러난다. (요청 수를 늘리면 이 저장소에 있는 supertest 전송 플레이크에
    // 그만큼 더 노출된다.)
    for (const raw of REJECTED.slice(0, 3)) {
      const signup = await request(app)
        .post("/api/auth/signup")
        .send({ email: `${PREFIX}s${n}@gonjiam.com`, password: PASSWORD, name: "홍길동", phone: raw });
      const create = await agent
        .post("/api/employees")
        .send({ name: "사전등록", email: `${PREFIX}c${n}@gonjiam.com`, phone: raw });
      const patch = await agent.patch(`/api/employees/${targetId}`).send({ phone: raw });
      expect([signup.status, create.status, patch.status], raw).toEqual([400, 400, 400]);
      n += 1;
    }

    for (const [raw, want] of PASTED.slice(0, 2)) {
      const signupEmail = `${PREFIX}s-ok${n}@gonjiam.com`;
      const createEmail = `${PREFIX}c-ok${n}@gonjiam.com`;
      const signup = await request(app)
        .post("/api/auth/signup")
        .send({ email: signupEmail, password: PASSWORD, name: "홍길동", phone: raw });
      const create = await agent.post("/api/employees").send({ name: "사전등록", email: createEmail, phone: raw });
      const patch = await agent.patch(`/api/employees/${targetId}`).send({ phone: raw });
      expect([signup.status, create.status, patch.status], raw).toEqual([201, 201, 200]);
      // 상태 코드만 같고 저장된 모양이 다르면 명부에 같은 번호가 두 모양으로 앉는다.
      expect([await phoneOf(signupEmail), await phoneOf(createEmail), patch.body.phone], raw).toEqual([
        want,
        want,
        want,
      ]);
      n += 1;
    }
  });
});
