import type { Kind, Grade } from "./types.ts";

export const KIND_LABEL: Record<Kind,string> = { rain:"폭우", snow:"폭설", wind:"강풍", heat:"폭염" };
export const GRADE_LABEL: Record<Grade,string> = { watch:"주의보", warning:"경보" };

export type GuidelineRow = { department_id: string; department_name: string;
  kind: Kind; grade: Grade; staff_actions: string[]; guest_notice: string };
// 수신자의 **발송 주소는 휴대폰 번호**다(카카오워크 user id에서 바뀌었다).
// null이거나 형식이 어긋난 값은 "그 사람에게는 특보가 가지 않는다"를 뜻한다 —
// 그 판정은 phone.ts의 isSendablePhone 하나가 내린다(여기서 되풀이하지 않는다).
export type RecipientRow = { department_id: string; employee_id: string;
  name: string; phone: string|null };
export type DeptBlock = { department_id: string; department_name: string;
  staff_actions: string[]; guest_notice: string;
  recipients: { employee_id: string; name: string; phone: string|null }[];
  selected: boolean };

export function composeDraft(kind: Kind, grade: Grade,
    guidelines: GuidelineRow[], recipients: RecipientRow[]): DeptBlock[] {
  return guidelines.filter(g => g.kind === kind && g.grade === grade).map(g => ({
    department_id: g.department_id, department_name: g.department_name,
    staff_actions: g.staff_actions, guest_notice: g.guest_notice,
    recipients: recipients.filter(r => r.department_id === g.department_id)
      .map(({ employee_id, name, phone }) => ({ employee_id, name, phone })),
    selected: true,
  }));
}

// 발송 본문의 "현재 관측" 한 줄. weather-tick의 자동 반복 발송과 사람이 승인한 최초 발송이
// 같은 포맷을 쓰도록 여기 한 곳에서만 만든다 (스펙 결정 11).
export type ObsRow = { rain_mm_per_hr?: number|null; temp_c?: number|null;
  feels_c?: number|null; wind_ms?: number|null };
export const OBS_LINE_FALLBACK = "발송 시점 상세는 대시보드 참조";

export function formatObsLine(obs: ObsRow|null|undefined): string {
  if (!obs) return OBS_LINE_FALLBACK;   // 트리거 관측 조회 실패 시에만 폴백
  return `시간당 ${obs.rain_mm_per_hr ?? "-"}mm · ${obs.temp_c ?? "-"}℃`
    + `(체감 ${obs.feels_c ?? "-"}) · 풍속 ${obs.wind_ms ?? "-"}m/s`;
}

export function renderMessage(b: DeptBlock,
    ctx: { kindLabel: string; gradeLabel: string; siteName: string; obsLine: string }): string {
  const lines = [
    `[${ctx.siteName}] ${ctx.kindLabel} ${ctx.gradeLabel} — ${b.department_name} 행동 지침`,
    `현재 관측: ${ctx.obsLine}`, "",
    "인력 조정 지침",
    ...b.staff_actions.map(a => `• ${a}`),
  ];
  if (b.guest_notice) lines.push("", "고객 안내 멘트", b.guest_notice);
  return lines.join("\n");
}
