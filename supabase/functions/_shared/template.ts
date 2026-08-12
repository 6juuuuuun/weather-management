import type { Kind, Grade } from "./types.ts";

export const KIND_LABEL: Record<Kind,string> = { rain:"폭우", snow:"폭설", wind:"강풍", heat:"폭염" };
export const GRADE_LABEL: Record<Grade,string> = { watch:"주의보", warning:"경보" };

export type GuidelineRow = { department_id: string; department_name: string;
  kind: Kind; grade: Grade; staff_actions: string[]; guest_notice: string };
export type RecipientRow = { department_id: string; employee_id: string;
  name: string; kakaowork_user_id: string|null };
export type DeptBlock = { department_id: string; department_name: string;
  staff_actions: string[]; guest_notice: string;
  recipients: { employee_id: string; name: string; kakaowork_user_id: string|null }[];
  selected: boolean };

export function composeDraft(kind: Kind, grade: Grade,
    guidelines: GuidelineRow[], recipients: RecipientRow[]): DeptBlock[] {
  return guidelines.filter(g => g.kind === kind && g.grade === grade).map(g => ({
    department_id: g.department_id, department_name: g.department_name,
    staff_actions: g.staff_actions, guest_notice: g.guest_notice,
    recipients: recipients.filter(r => r.department_id === g.department_id)
      .map(({ employee_id, name, kakaowork_user_id }) => ({ employee_id, name, kakaowork_user_id })),
    selected: true,
  }));
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
