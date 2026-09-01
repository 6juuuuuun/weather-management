import { describe, expect, test } from "vitest";
import { computeSetupChecklist } from "../setup";

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
