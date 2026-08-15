import { describe, expect, it } from "vitest";
import { ROLE_LABEL } from "../roles";

describe("ROLE_LABEL", () => {
  it("세 역할의 표시 이름을 제공한다", () => {
    expect(ROLE_LABEL.admin).toBe("시스템 관리자");
    expect(ROLE_LABEL.approver).toBe("부서장");
    expect(ROLE_LABEL.staff).toBe("실무자");
  });

  // '사업부장'은 직급 예시였을 뿐이고, 승인 권한이 alert_recipients로 옮겨간 뒤
  // 이 역할이 실제로 하는 일은 '전 부서 지침 열람'이다. 옛 라벨이 되살아나지 않게 고정한다.
  it("사업부장이라는 표현을 쓰지 않는다", () => {
    expect(Object.values(ROLE_LABEL)).not.toContain("사업부장");
  });
});
