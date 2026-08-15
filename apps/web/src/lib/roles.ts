import type { EmpRole } from "./types";

// 역할 표시 이름의 단일 출처. 화면마다 각자 정의하면 어긋난다(2026-08-13에 실제로 어긋났다).
//
// approver는 원래 '사업부장'으로 표기했으나, 사업부장은 이 자리에 앉힐 사람의 직급 예시였을 뿐이다.
// 승인 권한이 alert_recipients로 옮겨간 뒤 이 역할이 실제로 하는 일은 전 부서 지침 열람이므로
// 직급 색을 뺀 '부서장'으로 표기한다.
export const ROLE_LABEL: Record<EmpRole, string> = {
  admin: "시스템 관리자",
  approver: "부서장",
  staff: "실무자",
};
