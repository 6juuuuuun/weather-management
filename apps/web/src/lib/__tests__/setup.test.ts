import { describe, expect, test } from "vitest";
import { computeSetupChecklist, isValidGridCoord, GRID_NX_MAX, GRID_NY_MAX } from "../setup";

// 완전히 준비된 상태. 각 테스트는 여기서 한 가지만 어긋뜨린다.
const READY = {
  site: true,
  criteria: true,
  deptCount: 3,
  guidelineDeptCount: 3,
  alertRecipientCount: 1,
  notifiableAlertRecipientCount: 1,
  guidelineDeptWithoutRecipientCount: 0,
};

describe("computeSetupChecklist", () => {
  test("모두 완료면 done=7", () => {
    const r = computeSetupChecklist(READY);
    expect(r.done).toBe(7);
    expect(r.total).toBe(7);
    expect(r.items.every((i) => i.ok)).toBe(true);
  });

  test("지침 미등록 부서가 있으면 해당 항목 미완료", () => {
    const r = computeSetupChecklist({ ...READY, deptCount: 4, guidelineDeptCount: 2 });
    expect(r.items.find((i) => i.label === "부서별 지침")!.ok).toBe(false);
    expect(r.done).toBe(6);
  });

  test("아무것도 안 되어 있으면 done=0", () => {
    const r = computeSetupChecklist({
      site: false,
      criteria: false,
      deptCount: 0,
      guidelineDeptCount: 0,
      alertRecipientCount: 0,
      notifiableAlertRecipientCount: 0,
      guidelineDeptWithoutRecipientCount: 0,
    });
    expect(r.done).toBe(0);
    expect(r.items).toHaveLength(7);
  });

  test("특보 기준 8행 미만이면 특보 기준 항목 미완료", () => {
    const r = computeSetupChecklist({ ...READY, criteria: false });
    expect(r.items.find((i) => i.label.includes("특보 기준"))!.ok).toBe(false);
    expect(r.done).toBe(6);
  });

  // 이 항목이 없던 동안 이 시스템은 "설치 완료 5/5"를 띄우면서 특보를 한 건도
  // 전달하지 못했다. 수신자를 "지정했는가"와 그 사람에게 "닿을 수 있는가"는
  // 다른 질문이다 — 체크리스트가 뒤쪽까지 묻지 않으면 운영자는 준비가 끝난 줄 안다.
  test("수신자를 지정했어도 카카오워크에 연결된 사람이 0명이면 미완료다", () => {
    const r = computeSetupChecklist({ ...READY, alertRecipientCount: 2, notifiableAlertRecipientCount: 0 });
    const item = r.items.find((i) => i.label.includes("카카오워크"))!;
    expect(item).toBeDefined();
    expect(item.ok).toBe(false);
    // "Alert 수신자" 항목은 여전히 완료다 — 두 항목이 서로 다른 것을 본다는 뜻이다.
    expect(r.items.find((i) => i.label.includes("Alert 수신자"))!.ok).toBe(true);
    expect(r.done).toBe(6);
  });

  test("한 명이라도 연결되어 있으면 완료다", () => {
    const r = computeSetupChecklist({ ...READY, alertRecipientCount: 5, notifiableAlertRecipientCount: 1 });
    expect(r.items.find((i) => i.label.includes("카카오워크"))!.ok).toBe(true);
    expect(r.done).toBe(7);
  });

  // "0명에게 성공"의 뿌리(QA W-02). 지침을 등록한 부서에 부서 수신자가 없으면
  // 승인 발송이 0명에게 나가는데, 앞의 여섯 항목 중 어느 것도 그것을 보지 않았다 —
  // Alert 수신자(승인자)와 부서 수신자(발송 대상)는 다른 명단이다.
  test("지침은 있는데 부서 수신자가 없는 부서가 있으면 미완료다", () => {
    const r = computeSetupChecklist({ ...READY, guidelineDeptWithoutRecipientCount: 1 });
    const item = r.items.find((i) => i.label === "부서 수신자")!;
    expect(item).toBeDefined();
    expect(item.ok).toBe(false);
    // 지침 항목은 여전히 완료다 — 두 항목이 서로 다른 것을 본다는 뜻이다.
    expect(r.items.find((i) => i.label === "부서별 지침")!.ok).toBe(true);
    expect(r.done).toBe(6);
  });

  // 지침이 0건이면 "수신자가 없는 부서도 0곳"이라 이 항목이 조용히 초록이 될 수 있다.
  test("지침이 한 건도 없으면 부서 수신자 항목도 완료가 아니다", () => {
    const r = computeSetupChecklist({ ...READY, guidelineDeptCount: 0, guidelineDeptWithoutRecipientCount: 0 });
    expect(r.items.find((i) => i.label === "부서 수신자")!.ok).toBe(false);
  });
});

// QA W-10 · `nx: -1`을 저장하면 기상청 호출이 매시간 실패해 수집이 통째로 멈추는데,
// 체크리스트는 "관측 지점 ✓"로 완료를 계속 표시했다. 저장된 행이 있는지가 아니라
// 그 좌표로 수집이 될 수 있는지를 물어야 한다.
describe("isValidGridCoord (W-10)", () => {
  test("곤지암 시드 좌표는 유효하다", () => {
    expect(isValidGridCoord(61, 121)).toBe(true);
  });

  test("음수·0은 격자 밖이다", () => {
    expect(isValidGridCoord(-1, 121)).toBe(false);
    expect(isValidGridCoord(0, 121)).toBe(false);
    expect(isValidGridCoord(61, 0)).toBe(false);
  });

  test("격자 상한을 넘으면 밖이다", () => {
    expect(isValidGridCoord(GRID_NX_MAX, GRID_NY_MAX)).toBe(true);
    expect(isValidGridCoord(GRID_NX_MAX + 1, GRID_NY_MAX)).toBe(false);
    expect(isValidGridCoord(GRID_NX_MAX, GRID_NY_MAX + 1)).toBe(false);
    // 상수를 그대로 쓰는 위 세 줄은 상한을 아무리 크게 바꿔도 통과한다(변이 시험에서
    // 확인). 실제 값으로도 못박는다 — 이 범위는 기상청 격자 정의에서 온 것이지
    // 우리가 고를 수 있는 값이 아니다.
    expect(isValidGridCoord(150, 121)).toBe(false);
    expect(isValidGridCoord(61, 254)).toBe(false);
  });

  test("값이 없거나 숫자가 아니면 밖이다", () => {
    expect(isValidGridCoord(undefined, undefined)).toBe(false);
    expect(isValidGridCoord("61", "121")).toBe(false);
    expect(isValidGridCoord(61.5, 121)).toBe(false);
  });

  // 서버(server/src/kmaGrid.ts)와 같은 범위여야 한다. 두 값이 갈라지면 저장은
  // 막히는데 화면은 초록이거나 그 반대가 된다 — 이 결함의 본질이 그 어긋남이다.
  test("범위 상수가 서버와 같은 값이다", () => {
    expect([GRID_NX_MAX, GRID_NY_MAX]).toEqual([149, 253]);
  });

  test("좌표가 격자 밖이면 관측 지점 항목이 미완료가 된다", () => {
    const r = computeSetupChecklist({ ...READY, site: false });
    expect(r.items.find((i) => i.label === "관측 지점")!.ok).toBe(false);
    expect(r.done).toBe(6);
  });
});
