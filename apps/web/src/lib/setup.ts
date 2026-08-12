// 대시보드 셋업 체크리스트 — 순수 함수 (부수효과 없음, supabase 조회 결과를 입력으로 받는다)

export type SetupInput = {
  site: boolean; // 관측 지점(site_settings) 저장됨
  criteria: boolean; // 특보 기준(weather_criteria) 8행 존재
  deptCount: number; // 리프 부서 수
  guidelineDeptCount: number; // 지침이 1개 이상 등록된 리프 부서 수
  alertRecipientCount: number; // Alert 수신자(alert_recipients) 수
};

export type SetupItem = { label: string; ok: boolean };

export type SetupChecklist = {
  done: number;
  total: 5;
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
    { label: "Alert 수신자", ok: input.alertRecipientCount > 0 },
  ];

  return {
    done: items.filter((i) => i.ok).length,
    total: 5,
    items,
  };
}
