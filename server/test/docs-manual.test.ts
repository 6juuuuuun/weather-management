import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 운영 안내서가 코드와 어긋나는지 본다.
//
// 이 문서는 폭설 새벽에 리조트 직원이 유일하게 들고 있는 물건이다. 그런데 문서는
// 코드와 달리 아무도 실행해 보지 않아서, 세 번의 QA 라운드 내내 "화면에 없는 버튼",
// "제품이 더 이상 쓰지 않는 문구", "표에서 빠진 상태"가 반복해서 나왔다(QA W-23).
// 이번 라운드에도 워치독에 사유를 하나 새로 넣고 §3-3 표에 적지 않은 채 지나갔다 —
// 사람이 문서를 다시 읽는 것만으로는 막히지 않는다는 뜻이다.
//
// 그래서 **문서가 인용하는 문장을 코드에서 뽑아** 대조한다. 문구를 바꾸거나 사유를
// 새로 넣으면 이 테스트가 먼저 깨진다.
const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

const manual = read("docs/운영.md");

/**
 * 템플릿 문자열에서 **값이 끼어들지 않는 고정 조각**을 전부 뽑는다.
 *
 * 예전 판은 `(` 뒤(괄호 보충 설명)와 `—` 뒤(무엇을 하라)를 통째로 버리고, 남은 조각이
 * **하나라도** 문서에 있으면 통과시켰다. 이 시스템의 사유 문장은 대부분 뒤쪽에
 * `— 그래서 무엇을 하라`가 붙는데, 그 절반이 검사 대상 밖이었다. 회귀 검증 §C-1이
 * 변이로 확인했다: 사유의 처방을 **없는 화면 이름**으로 바꿔도 21건이 전부 통과했다.
 *
 * 그 결함(§C-1)의 모양이 정확히 이 파일이 막겠다고 선언한 결함(W-23: "§6-4가 승인
 * 수신자를 '알림 설정'에서 넣으라고 했다 — 그 목록은 특보 기준 화면에 있다")과 같다.
 * **위험을 알고, 막겠다고 선언하고, 정작 그 갈래는 테스트하지 않은 것이다.**
 *
 * 그래서 이제 `${...}`로만 자르고, 남은 조각(8자 이상)이 **전부** 문서에 있어야 한다.
 * 대가는 안내서가 사유 문장을 줄이지 않고 그대로 인용해야 한다는 것이고, 그것이
 * 이 표의 목적이다 — 운영자는 화면에서 본 문장을 표에서 그대로 찾는다.
 */
function fixedFragments(template: string): string[] {
  return template
    .split(/\$\{[^}]*\}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 8);
}

describe("운영 안내서 §3-3 — /api/health/deep의 사유가 전부 표에 있는가", () => {
  const watchdog = read("server/src/jobs/watchdog.ts");

  // reasons.push(`...`) / reasons.push("...")의 문자열을 그대로 긁는다.
  // 여러 줄에 걸쳐 이어 붙인 것(`... ` + `...`)도 한 덩어리로 본다.
  const literals = (body: string) =>
    [...body.matchAll(/[`"]([^`"]*)[`"]/g)].map(([, lit]) => lit).join("");
  const pushed = [
    ...[...watchdog.matchAll(/reasons\.push\(\s*([\s\S]*?)\s*\);/g)].map(([, body]) => literals(body!)),
    // catch 분기는 push가 아니라 `return { ok:false, reasons: [...] }`로 돌려준다.
    // 운영자가 503과 함께 가장 자주 보게 되는 사유 중 하나인데, 정규식이 push만
    // 훑는 바람에 문서 대조 대상에서 통째로 빠져 있었다(회귀 검증 §C-2).
    ...[...watchdog.matchAll(/reasons:\s*\[\s*([\s\S]*?)\s*\]/g)].map(([, body]) => literals(body!)),
  ].filter((t) => t.length > 0);

  // **상수로 뺀 사유는 위 정규식에 잡히지 않는다.** `reasons.push(LOG_ONLY_REASON)`에는
  // 문자열 리터럴이 없어서, 문구를 "발송 준비 중입니다"로 흐려도 위 대조는 조용히
  // 통과한다(변이로 확인했다). 이 파일이 한 번 "막겠다고 선언하고 못 막은" 전력이
  // 바로 이 모양이므로, 상수로 뺀 사유는 이름을 지목해 따로 묶는다.
  //
  // 이 사유는 지금 이 시스템의 상태를 대표하는 문장이고 사용자가 문구까지 정했다
  // (판정 2). 흐려지면 빨간불의 이유가 무엇이었는지 아무도 모르게 된다.
  it("상수로 뺀 사유(LOG_ONLY_REASON)도 안내서가 그대로 인용한다", () => {
    const literal = /export const LOG_ONLY_REASON = "([^"]+)";/.exec(watchdog)?.[1];
    expect(literal, "watchdog.ts에서 LOG_ONLY_REASON을 찾지 못했습니다").toBeTruthy();
    expect(literal).toBe("SMS 발송 설정이 아직 없습니다 — 인프라 연동 대기 중");
    expect(manual).toContain(literal!);
    // 화면(셋업 체크리스트)도 같은 사실을 말한다 — 서버만 알고 화면이 모르면
    // 운영자는 대시보드에서 그 상태를 볼 수 없다.
    const dashboard = read("apps/web/src/pages/Dashboard.tsx");
    expect(dashboard).toContain("SMS 발송 설정이 아직 없습니다");
  });

  it("사유를 한 건도 못 찾았다면 이 테스트 자체가 고장 난 것이다", () => {
    // 정규식이 소스 형태 변화로 빗나가면 아래 검사가 0건을 통과시킨다.
    expect(pushed.length).toBeGreaterThanOrEqual(13);
  });

  it.each(pushed.map((t) => [t.slice(0, 40), t] as const))(
    "«%s…» 가 §3-3 표에 적혀 있다",
    (_label, template) => {
      const fragments = fixedFragments(template);
      expect(fragments.length).toBeGreaterThan(0);
      // **전부** 있어야 한다. 하나라도 빠지면 그 부분(대개 "무엇을 하라")이 코드와
      // 문서에서 갈라졌다는 뜻이다.
      const missing = fragments.filter((f) => !manual.includes(f));
      expect(
        missing,
        `안내서 §3-3이 이 사유를 그대로 인용하지 않습니다:\n  ${template}\n  빠진 조각: ${missing.join(" / ")}`,
      ).toEqual([]);
    },
  );
});

describe("운영 안내서가 인용하는 화면 문구가 제품의 문구와 같은가", () => {
  // §6-3·§7-7이 "잠긴 사람 화면에 이렇게 뜹니다"라고 인용한다. 라운드 A가 이 문구를
  // 바꿨는데(로그인 실패와 잠금을 가르려고) 문서는 옛 문구를 그대로 들고 있었다 —
  // 그 문서를 보고 증상을 찾는 사람은 자기 증상을 표에서 찾지 못한다.
  it("계정 잠금 문구", () => {
    const routes = read("server/src/auth/routes.ts");
    expect(routes).toContain("회 잘못 입력해 계정이 잠겼습니다");
    expect(manual).toContain("잘못 입력해 계정이 잠겼습니다");
  });

  it("임시 비밀번호 만료 시간이 코드와 문서에서 같다", () => {
    const routes = read("server/src/auth/routes.ts");
    const hours = /const TEMP_PASSWORD_HOURS = (\d+);/.exec(routes)?.[1];
    expect(hours).toBeTruthy();
    expect(manual).toContain(`${hours}시간`);
  });

  it("재알림 상한이 코드와 문서에서 같다", () => {
    const remind = read("server/src/jobs/remindTick.ts");
    const limit = /export const REMIND_LIMIT = (\d+);/.exec(remind)?.[1];
    expect(limit).toBeTruthy();
    expect(manual).toContain(`재알림 ${limit}회`);
  });

  // 지침 본문 상한은 카카오워크 DM 길이를 정하는 값이다. 코드에서만 바꾸고 문서를
  // 두면, 안내서를 보고 쓴 지침이 저장에서 거부된다.
  it("지침 본문 상한이 코드와 문서에서 같다", () => {
    const content = read("server/src/api/content.ts");
    const item = /MAX_ACTION_LEN = (\d+)/.exec(content)?.[1];
    const count = /MAX_ACTION_ITEMS = (\d+)/.exec(content)?.[1];
    const notice = /MAX_GUEST_NOTICE = (\d+)/.exec(content)?.[1];
    expect([item, count, notice].every(Boolean)).toBe(true);
    expect(manual).toContain(`${item}자까지`);
    expect(manual).toContain(`${count}개까지`);
    expect(manual).toContain(`${notice}자까지`);
  });

  it("기상청 격자 범위가 코드와 문서에서 같다", () => {
    const grid = read("server/src/kmaGrid.ts");
    const nx = /GRID_NX_MAX = (\d+)/.exec(grid)?.[1];
    const ny = /GRID_NY_MAX = (\d+)/.exec(grid)?.[1];
    expect(nx).toBeTruthy();
    expect(ny).toBeTruthy();
    expect(manual).toContain(`nx 1~${nx}`);
    expect(manual).toContain(`ny 1~${ny}`);
  });
});

// QA W-08 · 승인 권한은 오직 alert_recipients 등록에서 나오고 역할과 무관하다.
// 규칙은 옳고(스펙 2026-08-13, db/migrations/0007) 코드도 그대로 동작한다.
// 문제는 그 규칙이 어디에도 적혀 있지 않았다는 것이다 — QA 엔지니어 한 명이 이것을
// 결함으로 신고했다가 다른 엔지니어가 정상 동작임을 확인해 취소했다. 전문가도
// 헷갈렸다면, 역할을 approver로 올려 놓고 승인 권한을 줬다고 믿는 관리자는 반드시
// 헷갈린다. 그 믿음이 깨지는 순간은 폭설 새벽에 아무도 승인하지 못할 때다.
describe("운영 안내서가 승인 권한 규칙을 밝히는가 (W-08)", () => {
  it("§1-6이 '역할이 아니라 Alert 수신자 목록이 승인 권한을 정한다'고 적는다", () => {
    expect(manual).toContain("승인 권한은 오직 이 목록에서 나옵니다");
    // 관리자가 실제로 하는 오해를 그대로 짚어야 한다.
    expect(manual).toMatch(/역할을 `승인자`로 올려도 \*\*승인 권한은 생기지 않습니다/);
    expect(manual).toMatch(/회수\*\*하려면 역할을 낮추는 것이 아니라/);
  });

  it("규칙이 코드와 같은 방향인지 확인한다 — 문서만 고치고 동작을 바꾸면 안 된다", () => {
    // send.ts의 승인 관문은 역할을 보지 않는다. 이 관계가 뒤집히면 문서가 거짓이 된다.
    const send = read("server/src/jobs/send.ts");
    const gate = /alert_recipients/.test(send);
    expect(gate).toBe(true);
  });
});

// 검증이 남긴 Minor 두 건은 코드를 바꾸지 않고 **안내서로** 닫았다. 그렇게 닫은 것은
// 코드가 바뀌면 조용히 거짓이 되므로, 여기서 코드와 묶어 둔다 — 안 그러면 "문서로
// 닫았다"가 곧 "닫지 않았다"가 된다.
describe("안내서로 닫은 항목이 코드와 같은 말을 하는가", () => {
  // 회귀 검증 §F-2 — 반복 발송·해제 알림은 매 회차 부서 수신자를 다시 조회한다
  // (QA W-06의 수정). 그래서 승인 화면에서 그 발송에 한해 편집한 명단은 1회차에만
  // 남는다. 사용자 결정(D-2)이고 동작은 그대로 두되, 운영자가 그 성질을 모르면
  // "내가 뺀 사람에게 계속 간다"로 읽는다.
  it("반복 발송이 매 회차 명단을 다시 읽는다는 사실을 안내서가 적는다", () => {
    const tick = read("server/src/jobs/weatherTick.ts");
    // 코드가 실제로 그렇게 동작한다(반복·해제 모두 refreshRecipients를 거친다).
    expect([...tick.matchAll(/refreshRecipients\(/g)].length).toBeGreaterThanOrEqual(3);
    expect(manual).toContain("매 회차 부서 수신자 명단을 다시 읽습니다");
    expect(manual).toMatch(/1회차에만/);
  });

  // 회귀 검증 §D-1 — 0015가 운영자가 손수 넣은 누적 임계값을 말없이 지운다.
  // 기존 마이그레이션 파일은 고칠 수 없고(전역 제약) 새 파일로 되살릴 값도 이미
  // 사라졌다. 동작상 피해는 없으므로 안내서가 그 사실을 적는 것으로 닫는다.
  it("0015가 폭설 누적 임계값을 비운다는 사실을 안내서가 적는다", () => {
    const mig = read("db/migrations/0015_snow_repeat_policy.sql");
    expect(mig).toMatch(/repeat_accum_threshold\s*=\s*null/i);
    expect(manual).toContain("repeat_accum_threshold");
    expect(manual).toMatch(/비웁니다/);
  });
});

// 검증 라운드 E 항목 1 — **안내서가 약속한 복구가 실제로 듣는가.**
//
// §6-3은 "비활성화→활성화를 누르면 풀립니다"라고 단언했는데, 그 경로는 DB의
// failed_attempts·locked_until만 지우고 프로세스 메모리의 속도 제한 버킷은 그대로
// 두었다 — 관리자가 풀어 줘도 그 사람은 여전히 429였다(검증 실측). 문서가 코드보다
// 앞서 나간 것이고, 폭설 새벽에 그 문장을 읽는 사람에게는 거짓말이 된다.
// 동작 검증은 login-rate-limit.test.ts가 HTTP 경로로 하고, 여기서는 **문서와 코드가
// 같은 말을 하는지**를 묶는다.
describe("안내서 §6-3의 계정 복구가 코드와 같은 말을 하는가", () => {
  const routes = read("server/src/auth/routes.ts");
  const rateLimit = read("server/src/auth/rateLimit.ts");

  it("관리자 복구가 속도 제한 창까지 비운다고 적고, 코드도 그렇게 한다", () => {
    expect(manual).toContain("429");
    expect(manual).toMatch(/함께 풀립니다/);
    // 상태 변경(비활성화→활성화)과 임시 비밀번호 발급 두 경로 모두에서 지운다.
    expect([...routes.matchAll(/loginRateLimiter\.clear\(/g)].length).toBeGreaterThanOrEqual(3);
  });

  it("429 횟수가 '이메일 × PC'로 셈해진다고 적고, 코드의 키도 그렇다", () => {
    expect(manual).toMatch(/이메일 하나가 아니라 .이메일 × 그 PC.로 셉니다/);
    // 키에 출처(IP)가 들어가야 제3자가 남의 창을 채울 수 없다.
    expect(rateLimit).toMatch(/emailIpKey\s*=\s*\(email: string, ip: string\)/);
  });
});

// 안내서가 "이 화면에서 하세요"라고 지시하는 곳은 실제 메뉴 이름이어야 한다.
// 없는 메뉴 이름을 적으면(예전 §3-3의 "조직·수신자 화면") 읽는 사람은 그 화면을
// 찾다가 포기한다.
describe("운영 안내서가 없는 화면 이름을 부르지 않는가", () => {
  const nav = read("apps/web/src/components/GlobalNav.tsx");
  const labels = [...nav.matchAll(/label: "([^"]+)"/g)].map(([, l]) => l!);

  it("네비게이션 메뉴 이름을 읽어 온다", () => {
    expect(labels).toContain("알림 설정");
    expect(labels).toContain("특보 기준");
    expect(labels).toContain("행동 지침");
  });

  it("안내서에 더 이상 존재하지 않는 화면 이름이 남아 있지 않다", () => {
    for (const dead of ["조직·수신자 화면", "지침 등록 화면"]) {
      expect(manual).not.toContain(dead);
    }
  });
});

// 이번 라운드에 늘어난 두 규칙은 **운영자가 실제로 만나는 화면 동작**이다.
// 하나는 거절 문구(§7-7 표), 하나는 .env 한 줄이 가입 화면의 모양을 바꾼다는 사실
// (§8 표)이다. 문서에만 적고 코드와 묶어 두지 않으면, 문구를 손보거나 화면 규칙을
// 바꾸는 순간 안내서가 조용히 거짓이 된다 — 이 파일이 존재하는 이유 그대로다.
describe("안내서가 이번에 늘어난 화면 규칙을 코드와 같게 적는가", () => {
  it("휴대폰 번호 거절 문구가 코드와 문서에서 같다", () => {
    const phone = read("server/src/phone.ts");
    const message = /PHONE_ERROR = "([^"]+)"/.exec(phone)?.[1];
    expect(message).toBeTruthy();
    // 문구 전체가 아니라 운영자가 표에서 찾을 앞부분을 대조한다(표에는 예시
    // 괄호를 넣지 않는다).
    expect(manual).toContain(message!.split(" (")[0]);
  });

  it("허용 번호대가 코드와 문서에서 같다", () => {
    const phone = read("server/src/phone.ts");
    // 010은 11자리, 그 밖의 구 번호대는 10 또는 11자리 — 정규식이 진실이다.
    expect(phone).toMatch(/\^010\\d\{8\}\$/);
    expect(phone).toMatch(/\^01\[16789\]\\d\{7,8\}\$/);
    expect(manual).toMatch(/`010`은 11자리/);
    expect(manual).toMatch(/`011·016·017·018·019`는 10 또는 11자리/);
  });

  // 도메인이 딱 하나일 때만 가입 화면이 "아이디 + 고정 도메인"으로 갈린다.
  // 이 조건이 코드에서 바뀌면(예: 첫 도메인을 무조건 고정하면) 둘 이상을 설정한
  // 운영자의 화면이 말없이 달라진다.
  it("가입 화면이 갈리는 조건(도메인 정확히 1개)이 코드와 문서에서 같다", () => {
    const signup = read("apps/web/src/pages/Signup.tsx");
    expect(signup).toMatch(/domains\.length === 1/);
    expect(manual).toMatch(/값이 딱 하나면 가입 화면의 이메일 칸이/);
  });
});
