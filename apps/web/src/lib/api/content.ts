// server/src/api/content.ts의 엔드포인트에 대응한다.
import { apiGet, apiSend } from "./client";
import type { DeptBlock, Grade, Kind } from "../types";

export type GuidelineRow = {
  id: string;
  department_id: string;
  kind: Kind;
  grade: Grade;
  staff_actions: string[];
  guest_notice: string;
  updated_at: string;
  updated_by: string | null;
  // 서버가 수정 시점에 스냅샷한 이름이다. updated_by(직원 id)는 그 사람이 삭제되면
  // null이 되므로, 화면이 이름을 그리려면 이 값이 필요하다(QA W-01 · 결정 D-1).
  updated_by_name: string | null;
};

export const guidelines = () => apiGet<GuidelineRow[]>("/api/guidelines");
export const saveGuidelines = (
  rows: Pick<GuidelineRow, "department_id" | "kind" | "grade" | "staff_actions" | "guest_notice">[],
) => apiSend<null>("PUT", "/api/guidelines", { rows });

export type MessageRow = {
  id: string;
  event_id: string;
  status: "draft" | "approved";
  content: DeptBlock[];
  updated_at: string;
  updated_by: string | null;
  updated_by_name: string | null;
};

export const messagesOf = (eventId: string) => apiGet<MessageRow[]>(`/api/messages?event_id=${encodeURIComponent(eventId)}`);

// w_approver 정책이 alert_recipients 등록 여부로 판정한다(role이 아니다) — 그
// 정책에 안 걸리면 서버가 403을, 메시지 자체가 없으면 404를 돌려준다.
export const saveDraftMessage = (id: string, content: DeptBlock[]) =>
  apiSend<MessageRow>("PATCH", `/api/messages/${encodeURIComponent(id)}`, { content });

// dispatches — History.tsx/Dashboard.tsx. weather_events(kind,grade,detected_at)와
// messages.content(message_content, 스냅샷 없는 옛 이력의 폴백)를 서버가 이미 조인해 내려준다.
// include_test를 안 보내면(또는 true가 아니면) 테스트 발송이 빠진다 — History.tsx의
// 기존 `.eq("is_test", false)`와 동일한 기본값이므로 클라이언트에서 다시 거르지 않는다.
export type DispatchRow = {
  id: number;
  message_id: string;
  event_id: string;
  sent_at: string;
  channel: string;
  repeat_no: number;
  is_test: boolean;
  results: { employee_id: string; name: string; ok: boolean; error?: string }[];
  content: DeptBlock[] | null;
  kind: Kind;
  grade: Grade;
  detected_at: string;
  message_content: DeptBlock[];
  // 이미 해제된 특보를 지난주 관측값으로 재발송할 수 있었다(QA W-11). 서버가 특보와
  // 메시지의 현재 상태를 함께 내려 주므로, 화면이 그 행의 재발송 버튼을 아예 그리지 않는다.
  event_status: "PENDING_APPROVAL" | "ACTIVE" | "RESOLVED" | "ESCALATED" | "DISMISSED";
  message_status: "draft" | "approved";
};

export const dispatches = (opts?: { limit?: number; since?: string; includeTest?: boolean }) => {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.since) params.set("since", opts.since);
  if (opts?.includeTest) params.set("include_test", "true");
  const qs = params.toString();
  return apiGet<DispatchRow[]>(`/api/dispatches${qs ? `?${qs}` : ""}`);
};
