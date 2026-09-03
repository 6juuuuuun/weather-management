// 대시보드 셋업 체크리스트 — 순수 함수 (부수효과 없음, 서버 조회 결과를 입력으로 받는다)

// 기상청 단기예보 격자의 유효 범위. **server/src/kmaGrid.ts와 같은 값이어야 한다.**
// 두 패키지가 코드를 공유하지 않으므로 값이 두 곳에 적힌다 — 서버가 저장을 막는
// 범위와 화면이 "설정 완료"라고 말하는 범위가 다르면, 저장은 막히는데 화면은
// 초록이거나 그 반대가 된다.
export const GRID_NX_MAX = 149;
export const GRID_NY_MAX = 253;

/**
 * 관측 지점 좌표가 쓸 수 있는 값인가.
 *
 * 이 검사가 없던 동안 `nx: -1`이 저장되면 기상청 호출이 매시간 실패해 **수집이
 * 통째로 멈추는데** 체크리스트는 "관측 지점 ✓"로 6/6이었다(QA W-10). 행이
 * 있는지가 아니라 그 값으로 수집이 될 수 있는지를 물어야 한다.
 */
export function isValidGridCoord(nx: unknown, ny: unknown): boolean {
  return (
    typeof nx === "number" && Number.isInteger(nx) && nx >= 1 && nx <= GRID_NX_MAX &&
    typeof ny === "number" && Number.isInteger(ny) && ny >= 1 && ny <= GRID_NY_MAX
  );
}

/**
 * 이 지침 행이 실제로 보낼 내용을 담고 있는가.
 *
 * **server/src/guidelineContent.ts의 hasGuidelineContent와 같은 규칙이어야 한다.**
 * 웹과 서버는 별개 npm 패키지라 코드를 공유할 통로가 없다(MIN_PASSWORD·격자 범위와
 * 같은 사정). 두 곳이 어긋나 있던 동안, 공백만 든 지침 한 줄이 `/api/health/deep`을
 * 503으로 만드는데 이 화면은 같은 부서를 "지침 없음"으로 셌다 — 두 화면이 정반대로
 * 말했다(회귀 검증 §B-1). 화면 쪽(대시보드 체크리스트·행동 지침 화면)은 이 함수
 * 하나만 쓴다.
 */
export function hasGuidelineContent(g: {
  staff_actions?: readonly (string | null)[] | null;
  guest_notice?: string | null;
}): boolean {
  const actions = g.staff_actions ?? [];
  return actions.some((a) => (a ?? "").trim() !== "") || (g.guest_notice ?? "").trim() !== "";
}

export type SetupInput = {
  // 관측 지점(site_settings)이 저장돼 있고 **그 좌표로 수집이 가능한가**.
  site: boolean;
  criteria: boolean; // 특보 기준(weather_criteria) 8행 존재
  deptCount: number; // 리프 부서 수
  guidelineDeptCount: number; // 지침이 1개 이상 등록된 리프 부서 수
  alertRecipientCount: number; // Alert 수신자(alert_recipients) 수
  // Alert 수신자 중 **실제로 특보를 보낼 수 있는** 사람 수.
  //
  // 이 항목이 없던 동안 이 시스템은 "설치 완료 5/5"를 띄우면서 특보를 한 건도
  // 전달하지 못했다. 수신자를 "지정했는가"와 그 사람에게 "닿을 수 있는가"는 다른
  // 질문이고, 체크리스트는 뒤쪽까지 물어야 한다.
  //
  // **SMS로 바뀌면서 이 값의 근거가 카카오워크 연결에서 휴대폰 번호로 옮겨 왔다.**
  // 묻는 것은 글자 하나 달라지지 않았다 — 이 값이 0이면 특보가 아무에게도 가지
  // 않는다. 연결이라는 절차가 사라졌다고 이 항목까지 사라지면, QA가 네 번 찾아낸
  // 결함이 그대로 돌아온다. 세는 기준(`notifiable`)은 서버가 판정해 내려준다.
  notifiableAlertRecipientCount: number;
  // 지침이 등록된 리프 부서 중 **부서 수신자가 한 명도 없는** 부서 수.
  //
  // 이 항목이 없던 동안 체크리스트는 6/6 초록인데 승인 발송이 0명에게 나갈 수
  // 있었다(QA W-02). "지침을 등록했는가"와 "그 지침을 받을 사람이 있는가"는 다른
  // 질문이고, Alert 수신자(승인자)와 부서 수신자(실제 발송 대상)도 다른 명단이다 —
  // 앞의 다섯 항목 중 어느 것도 부서 수신자를 보지 않는다.
  guidelineDeptWithoutRecipientCount: number;
  // 지침이 등록된 리프 부서 중 **수신자는 있으나 그중 보낼 수 있는 번호를 가진
  // 사람이 한 명도 없는** 부서 수.
  //
  // 이 항목이 없던 동안 체크리스트 7/7이 초록인 채로 승인 발송과 매시간 반복 발송이
  // 0명에게 나갔다(검증 §신규-1 — "알릴 수 없는데 전부 초록"의 네 번째 경로).
  // 앞의 `수신자 전화번호` 항목은 **Alert 수신자(승인자)** 만 센다. 특보를 실제로
  // 받는 사람은 부서 수신자이고, 그 명단의 연락 가능 여부는 어느 항목도 보지 않았다.
  // "지정했는가"에서 "닿을 수 있는가"까지 묻는 것이 이 항목의 존재 이유다.
  guidelineDeptWithoutNotifiableRecipientCount: number;
  // 실효 발송 채널이 **로그 전용**인가.
  //
  // 앞의 일곱 항목은 전부 "그 사람에게 **닿을 수 있는가**"만 묻는다. 그런데 이 값이
  // 참이면 그 답이 전부 예스인 채로 **모든 메시지가 사람 대신 앱 로그로만 나간다** —
  // 수신자·승인자는 전부 "닿을 수 있음"이고, 승인은 `{"ok":true,"sent_count":1}`을
  // 돌려주고, 체크리스트는 7/7이었다(검증 라운드 E, 표에 없던 25번째 경로).
  // "닿을 수 있는가" 옆에 **"어디로 가는가"**를 묻는 항목이 이것이다.
  //
  // **지금은 이 값이 언제나 참이다.** LMS 제공자 계정 자료를 아직 받지 못해 로그
  // 전용이 유일한 구현이기 때문이다. 그래서 이 항목은 당분간 계속 빨간불이고,
  // 그것이 사실이다 — 초록으로 바꾸는 순간 이 프로젝트가 여섯 라운드 내내 싸운
  // 바로 그 결함("못 알리는데 전부 초록")을 스스로 다시 만든다(사용자 판정 2).
  logOnlyChannel: boolean;
};

export type SetupItem = { label: string; ok: boolean };

export type SetupChecklist = {
  done: number;
  total: 8;
  items: SetupItem[];
};

export function computeSetupChecklist(input: SetupInput): SetupChecklist {
  const items: SetupItem[] = [
    { label: "관측 지점", ok: input.site },
    { label: "특보 기준", ok: input.criteria },
    { label: "부서 구성", ok: input.deptCount > 0 },
    {
      label: "부서별 지침",
      ok: input.deptCount > 0 && input.guidelineDeptCount >= input.deptCount,
    },
    {
      label: "부서 수신자",
      ok:
        input.guidelineDeptCount > 0 &&
        input.guidelineDeptWithoutRecipientCount === 0 &&
        // 지정만 되고 아무도 보낼 수 있는 번호가 없는 부서가 있으면 그 부서 몫은
        // 승인해도 0명에게 나간다 — 지정 여부만 보면 그 상태가 초록으로 보인다.
        input.guidelineDeptWithoutNotifiableRecipientCount === 0,
    },
    { label: "Alert 수신자", ok: input.alertRecipientCount > 0 },
    { label: "수신자 전화번호", ok: input.notifiableAlertRecipientCount > 0 },
    // 앞의 일곱 항목이 전부 초록이어도 이 항목이 빨간불이면 특보는 아무에게도
    // 도착하지 않는다 — 로그 파일로 "성공"할 뿐이다.
    { label: "실제 발송", ok: !input.logOnlyChannel },
  ];

  return {
    done: items.filter((i) => i.ok).length,
    total: 8,
    items,
  };
}
