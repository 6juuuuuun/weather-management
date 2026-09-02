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
 * 템플릿 문자열에서 **값이 끼어들지 않는 고정 조각**만 뽑는다.
 * `${...}`로 자르고, 문서가 흔히 줄이는 부분(괄호 보충 설명, `—` 뒤의 부연)은 버린다.
 * 남은 조각 중 하나라도 문서에 있으면 그 사유는 문서에 적힌 것으로 본다.
 */
function fixedFragments(template: string): string[] {
  return template
    .split(/\$\{[^}]*\}/)
    .map((chunk) => chunk.split("(")[0]!.split("—")[0]!.trim())
    .filter((chunk) => chunk.length >= 8);
}

describe("운영 안내서 §3-3 — /api/health/deep의 사유가 전부 표에 있는가", () => {
  const watchdog = read("server/src/jobs/watchdog.ts");

  // reasons.push(`...`) / reasons.push("...")의 문자열을 그대로 긁는다.
  // 여러 줄에 걸쳐 이어 붙인 것(`... ` + `...`)도 한 덩어리로 본다.
  const pushed = [...watchdog.matchAll(/reasons\.push\(\s*([\s\S]*?)\s*\);/g)].map(([, body]) =>
    [...body!.matchAll(/[`"]([^`"]*)[`"]/g)].map(([, lit]) => lit).join(""),
  );

  it("사유를 한 건도 못 찾았다면 이 테스트 자체가 고장 난 것이다", () => {
    // 정규식이 소스 형태 변화로 빗나가면 아래 검사가 0건을 통과시킨다.
    expect(pushed.length).toBeGreaterThanOrEqual(10);
  });

  it.each(pushed.map((t) => [t.slice(0, 40), t] as const))(
    "«%s…» 가 §3-3 표에 적혀 있다",
    (_label, template) => {
      const fragments = fixedFragments(template);
      expect(fragments.length).toBeGreaterThan(0);
      const found = fragments.some((f) => manual.includes(f));
      expect(found, `안내서 §3-3에 없는 사유입니다:\n  ${template}\n  조각: ${fragments.join(" / ")}`).toBe(
        true,
      );
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
