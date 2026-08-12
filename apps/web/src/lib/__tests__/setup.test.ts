import { describe, expect, test } from "vitest";
import { computeSetupChecklist } from "../setup";

describe("computeSetupChecklist", () => {
  test("모두 완료면 done=5", () => {
    const r = computeSetupChecklist({
      site: true,
      criteria: true,
      deptCount: 3,
      guidelineDeptCount: 3,
      alertRecipientCount: 1,
    });
    expect(r.done).toBe(5);
    expect(r.total).toBe(5);
    expect(r.items.every((i) => i.ok)).toBe(true);
  });

  test("지침 미등록 부서가 있으면 해당 항목 미완료", () => {
    const r = computeSetupChecklist({
      site: true,
      criteria: true,
      deptCount: 4,
      guidelineDeptCount: 2,
      alertRecipientCount: 0,
    });
    expect(r.items.find((i) => i.label.includes("지침"))!.ok).toBe(false);
    expect(r.done).toBe(3);
  });

  test("아무것도 안 되어 있으면 done=0", () => {
    const r = computeSetupChecklist({
      site: false,
      criteria: false,
      deptCount: 0,
      guidelineDeptCount: 0,
      alertRecipientCount: 0,
    });
    expect(r.done).toBe(0);
    expect(r.items).toHaveLength(5);
  });

  test("특보 기준 8행 미만이면 특보 기준 항목 미완료", () => {
    const r = computeSetupChecklist({
      site: true,
      criteria: false,
      deptCount: 3,
      guidelineDeptCount: 3,
      alertRecipientCount: 1,
    });
    expect(r.items.find((i) => i.label.includes("특보 기준"))!.ok).toBe(false);
    expect(r.done).toBe(4);
  });
});
