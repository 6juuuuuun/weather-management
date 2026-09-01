// 대시보드 셋업 체크리스트 — 순수 함수 (부수효과 없음, 서버 조회 결과를 입력으로 받는다)

export type SetupInput = {
  site: boolean; // 관측 지점(site_settings) 저장됨
  criteria: boolean; // 특보 기준(weather_criteria) 8행 존재
  deptCount: number; // 리프 부서 수
  guidelineDeptCount: number; // 지침이 1개 이상 등록된 리프 부서 수
  alertRecipientCount: number; // Alert 수신자(alert_recipients) 수
  // Alert 수신자 중 카카오워크 user id가 실제로 채워진 사람 수.
  //
  // 이 항목이 없던 동안 이 시스템은 "설치 완료 5/5"를 띄우면서 특보를 한 건도
  // 전달하지 못했다. employees.kakaowork_user_id를 채우는 경로가 이관에서 통째로
  // 빠졌는데(매직링크 로그인이 하던 일이었다), 모든 알림 경로가 그 값으로 수신자를
  // 거르기 때문이다. 수신자를 "지정했는가"와 그 사람에게 "닿을 수 있는가"는 다른
  // 질문이고, 체크리스트는 뒤쪽까지 물어야 한다.
  notifiableAlertRecipientCount: number;
  // 지침이 등록된 리프 부서 중 **부서 수신자가 한 명도 없는** 부서 수.
  //
  // 이 항목이 없던 동안 체크리스트는 6/6 초록인데 승인 발송이 0명에게 나갈 수
  // 있었다(QA W-02). "지침을 등록했는가"와 "그 지침을 받을 사람이 있는가"는 다른
  // 질문이고, Alert 수신자(승인자)와 부서 수신자(실제 발송 대상)도 다른 명단이다 —
  // 앞의 다섯 항목 중 어느 것도 부서 수신자를 보지 않는다.
  guidelineDeptWithoutRecipientCount: number;
};

export type SetupItem = { label: string; ok: boolean };

export type SetupChecklist = {
  done: number;
  total: 7;
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
      ok: input.guidelineDeptCount > 0 && input.guidelineDeptWithoutRecipientCount === 0,
    },
    { label: "Alert 수신자", ok: input.alertRecipientCount > 0 },
    { label: "카카오워크 연결", ok: input.notifiableAlertRecipientCount > 0 },
  ];

  return {
    done: items.filter((i) => i.ok).length,
    total: 7,
    items,
  };
}
