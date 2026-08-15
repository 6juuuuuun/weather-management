import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AppLayout } from "../components/AppLayout";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { callSend } from "../lib/api";
import type {
  AlertSetting,
  DeptBlock,
  EventStatus,
  Grade,
  Kind,
  Message,
  WeatherCriteria,
  WeatherEvent,
  WeatherObservation,
} from "../lib/types";
import "./EventReview.css";

type CandidateRecipient = { employee_id: string; name: string; kakaowork_user_id: string | null };

type Banner = { type: "danger" | "info"; text: string };

const KIND_LABEL: Record<Kind, string> = { rain: "폭우", snow: "폭설", wind: "강풍", heat: "폭염" };
const GRADE_LABEL: Record<Grade, string> = { watch: "주의보", warning: "경보" };

const STATUS_LABEL: Record<EventStatus, string> = {
  PENDING_APPROVAL: "승인 대기",
  ACTIVE: "발송 완료",
  RESOLVED: "해제됨",
  ESCALATED: "격상됨",
  DISMISSED: "무시됨",
};

const STATUS_CLASS: Record<EventStatus, string> = {
  PENDING_APPROVAL: "status-tag-pending",
  ACTIVE: "status-tag-active",
  RESOLVED: "status-tag-resolved",
  ESCALATED: "status-tag-escalated",
  DISMISSED: "status-tag-dismissed",
};

type NumericObsKey = "rain_mm_per_hr" | "temp_c" | "wind_ms" | "humidity_pct" | "snow_new_cm" | "feels_c";
// "daily_accum"은 관측 1건의 필드가 아니라 KST 자정 이후 합산값(판정 엔진의
// todayAccums와 동일 로직, supabase/functions/_shared/db.ts 참조)으로 별도 계산한다.
type MetricSource = NumericObsKey | "daily_accum";
type MetricDef = { key: MetricSource; label: string; unit: string };

const KIND_METRICS: Record<Kind, MetricDef[]> = {
  rain: [
    { key: "rain_mm_per_hr", label: "시간당 강수량", unit: "mm" },
    { key: "daily_accum", label: "일 누적", unit: "mm" },
    { key: "wind_ms", label: "풍속", unit: "m/s" },
  ],
  snow: [
    { key: "snow_new_cm", label: "신적설", unit: "cm" },
    { key: "daily_accum", label: "일 누적", unit: "cm" },
    { key: "temp_c", label: "기온", unit: "℃" },
  ],
  wind: [
    { key: "wind_ms", label: "풍속", unit: "m/s" },
    { key: "temp_c", label: "기온", unit: "℃" },
    { key: "humidity_pct", label: "습도", unit: "%" },
  ],
  heat: [
    { key: "temp_c", label: "기온", unit: "℃" },
    { key: "feels_c", label: "체감온도", unit: "℃" },
    { key: "humidity_pct", label: "습도", unit: "%" },
  ],
};

// 판정 엔진(supabase/functions/_shared/db.ts의 todayAccums)과 동일 기준: KST 자정 이후 합산
const DAILY_ACCUM_FIELD: Partial<Record<Kind, "rain_mm_per_hr" | "snow_new_cm">> = {
  rain: "rain_mm_per_hr",
  snow: "snow_new_cm",
};

function kstMidnightISO(now: Date): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const midnightKst = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000);
  return midnightKst.toISOString();
}

const TRIGGER_THRESHOLD_KEY: Record<Kind, string> = {
  rain: "rain_mm_per_hr",
  snow: "snow_cm",
  wind: "wind_ms",
  heat: "temp_c",
};

function formatHM(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatNum(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "-";
  return v.toFixed(digits);
}

function repeatPolicyCaption(setting: AlertSetting | null): string {
  if (!setting) return "반복 알림 설정 정보를 불러오지 못했습니다.";
  if (setting.repeat_policy === "once") return "반복 알림 설정: 1회만 발송되며 자동으로 재발송하지 않습니다.";
  if (setting.repeat_policy === "hourly_until_below")
    return "반복 알림 설정: 기준 미달될 때까지 매시간 자동 재발송 (추가 승인 불필요)";
  const threshold = setting.repeat_accum_threshold ?? "-";
  return `반복 알림 설정: 일 누적량이 ${threshold} 미만이 될 때까지 반복 발송 (추가 승인 불필요)`;
}

function IconCloud() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M17 8a4 4 0 0 1-.3 8H8a3.5 3.5 0 0 1-.6-6.95A4 4 0 0 1 15 6.1 4 4 0 0 1 17 8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M21 3 3 10.5l7 2.5 2 7L21 3Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconRepeat() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M4 12a8 8 0 0 1 13.5-5.8M20 12a8 8 0 0 1-13.5 5.8M17 3v4h-4M7 21v-4h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function isInteractiveTarget(e: MouseEvent<HTMLDivElement>): boolean {
  const el = e.target as HTMLElement;
  return Boolean(el.closest("input, textarea, button, select, label, a"));
}

function DeptBlockCard({
  block,
  grade,
  canEdit,
  isEditing,
  isOwn,
  onCardClick,
  onToggleSelected,
  onOpenEdit,
  onCloseEdit,
  onUpdateAction,
  onRemoveAction,
  onAddAction,
  onUpdateNotice,
}: {
  block: DeptBlock;
  grade: Grade;
  canEdit: boolean;
  isEditing: boolean;
  isOwn: boolean;
  onCardClick: (e: MouseEvent<HTMLDivElement>) => void;
  onToggleSelected: (checked: boolean) => void;
  onOpenEdit: (e: MouseEvent) => void;
  onCloseEdit: (e: MouseEvent) => void;
  onUpdateAction: (idx: number, value: string) => void;
  onRemoveAction: (idx: number) => void;
  onAddAction: () => void;
  onUpdateNotice: (value: string) => void;
}) {
  const classNames = ["dept-block"];
  if (canEdit) classNames.push("dept-block-editable");
  if (isEditing) classNames.push("dept-block-editing");
  if (isOwn) classNames.push("dept-block-own");
  if (canEdit && !block.selected) classNames.push("dept-block-unselected");

  return (
    <div className={classNames.join(" ")} onClick={canEdit ? onCardClick : undefined}>
      <div className="dept-block-head">
        {canEdit && (
          <input
            type="checkbox"
            className="review-checkbox"
            checked={block.selected}
            aria-label={`${block.department_name} 선택`}
            onChange={(e) => onToggleSelected(e.target.checked)}
          />
        )}
        <h3 className="dept-block-name">{block.department_name}</h3>
        <Badge grade={grade} />
        <span className="dept-block-head-spacer" />
        {canEdit &&
          (isEditing ? (
            <button type="button" className="dept-block-editing-tag" onClick={onCloseEdit}>
              ✎ 수정 중
            </button>
          ) : (
            <button
              type="button"
              className="dept-block-edit-icon"
              aria-label={`${block.department_name} 편집`}
              onClick={onOpenEdit}
            >
              ✎
            </button>
          ))}
      </div>

      <ul className="dept-block-actions">
        {block.staff_actions.map((action, idx) =>
          isEditing ? (
            <li key={idx}>
              <input
                className="action-input"
                value={action}
                aria-label={`${block.department_name} 지침 ${idx + 1}`}
                onChange={(e) => onUpdateAction(idx, e.target.value)}
              />
              <button
                type="button"
                className="action-remove"
                aria-label={`${block.department_name} 지침 ${idx + 1} 삭제`}
                onClick={() => onRemoveAction(idx)}
              >
                ×
              </button>
            </li>
          ) : (
            <li key={idx}>
              <span>{action}</span>
            </li>
          ),
        )}
      </ul>
      {isEditing && (
        <button type="button" className="action-add" onClick={onAddAction}>
          + 지침 추가
        </button>
      )}

      {(isEditing || block.guest_notice) && (
        <div className="dept-block-notice">
          <span className="dept-block-notice-label">고객 안내 멘트</span>
          {isEditing ? (
            <textarea
              className="dept-block-notice-textarea"
              value={block.guest_notice}
              aria-label={`${block.department_name} 고객 안내 멘트`}
              onChange={(e) => onUpdateNotice(e.target.value)}
            />
          ) : (
            <p className="dept-block-notice-text">{block.guest_notice}</p>
          )}
        </div>
      )}

      <p className="dept-block-recipients">
        {/* 빈 경우에 "수신 지정된 수신자 없음"으로 읽히던 것을 접두사 없이 한 문장으로 바꾼다. */}
        {block.recipients.length > 0
          ? `수신 ${block.recipients.map((r) => r.name).join(", ")}`
          : "수신자가 지정되지 않았습니다"}
      </p>
    </div>
  );
}

export default function EventReview() {
  const { id } = useParams<{ id: string }>();
  const { employee, isApprover, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [event, setEvent] = useState<WeatherEvent | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [content, setContent] = useState<DeptBlock[]>([]);
  const [observation, setObservation] = useState<WeatherObservation | null>(null);
  const [dailyAccum, setDailyAccum] = useState<number | null>(null);
  const [criteria, setCriteria] = useState<WeatherCriteria | null>(null);
  const [alertSetting, setAlertSetting] = useState<AlertSetting | null>(null);
  const [candidatesByDept, setCandidatesByDept] = useState<Record<string, CandidateRecipient[]>>({});

  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);
  const [pendingCandidate, setPendingCandidate] = useState("");
  const [dismissModalOpen, setDismissModalOpen] = useState(false);

  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setLoadError(null);

      const [evRes, msgRes] = await Promise.all([
        supabase.from("weather_events").select("*").eq("id", id).single(),
        supabase.from("messages").select("*").eq("event_id", id).single(),
      ]);
      if (!active) return;

      const ev = evRes.data as WeatherEvent | null;
      const msg = msgRes.data as Message | null;
      if (evRes.error || !ev || msgRes.error || !msg) {
        setLoadError("특보 이벤트를 찾을 수 없습니다.");
        setLoading(false);
        return;
      }

      setEvent(ev);
      setMessageId(msg.id);
      setContent(msg.content ?? []);

      const accumField = DAILY_ACCUM_FIELD[ev.kind];
      const [obsRes, criteriaRes, alertRes, accumRes] = await Promise.all([
        ev.trigger_observation_id
          ? supabase.from("weather_observations").select("*").eq("id", ev.trigger_observation_id).single()
          : Promise.resolve({ data: null }),
        supabase.from("weather_criteria").select("*").eq("kind", ev.kind).eq("grade", ev.grade).single(),
        supabase.from("alert_settings").select("*").eq("kind", ev.kind).single(),
        accumField
          ? supabase
              .from("weather_observations")
              .select(accumField)
              .gte("observed_at", kstMidnightISO(new Date()))
              .eq("missing", false)
          : Promise.resolve({ data: null }),
      ]);
      if (!active) return;
      setObservation((obsRes.data as WeatherObservation | null) ?? null);
      setCriteria((criteriaRes.data as WeatherCriteria | null) ?? null);
      setAlertSetting((alertRes.data as AlertSetting | null) ?? null);

      if (accumField) {
        const rows = (accumRes.data ?? []) as Record<string, number | null>[];
        setDailyAccum(rows.length === 0 ? null : rows.reduce((sum, r) => sum + Number(r[accumField] ?? 0), 0));
      } else {
        setDailyAccum(null);
      }

      const deptIds = [...new Set((msg.content ?? []).map((b) => b.department_id))];
      if (deptIds.length > 0) {
        const { data: recRows } = await supabase
          .from("recipients")
          .select("department_id, employee_id, employees(name, kakaowork_user_id)")
          .in("department_id", deptIds);
        if (!active) return;
        const map: Record<string, CandidateRecipient[]> = {};
        for (const row of (recRows ?? []) as any[]) {
          const emp = Array.isArray(row.employees) ? row.employees[0] : row.employees;
          if (!emp) continue;
          const list = map[row.department_id] ?? [];
          list.push({ employee_id: row.employee_id, name: emp.name, kakaowork_user_id: emp.kakaowork_user_id ?? null });
          map[row.department_id] = list;
        }
        setCandidatesByDept(map);
      }

      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [id]);

  // 승인 권한은 역할이 아니라 Alert 수신자 등록 여부로 판정한다(AuthProvider.isApprover).
  // 서버(send Edge Function)가 최종 게이트이므로 이 값은 화면 노출 제어용이다.
  const canEdit = isApprover && event?.status === "PENDING_APPROVAL";

  function isOwnDept(block: DeptBlock): boolean {
    return employee?.role === "staff" && employee.department_id === block.department_id;
  }

  function updateBlock(deptId: string, updater: (b: DeptBlock) => DeptBlock) {
    setContent((cs) => cs.map((b) => (b.department_id === deptId ? updater(b) : b)));
  }

  function toggleSelectAll(next: boolean) {
    setContent((cs) => cs.map((b) => ({ ...b, selected: next })));
  }

  function toggleBlockSelected(deptId: string, next: boolean) {
    updateBlock(deptId, (b) => ({ ...b, selected: next }));
  }

  function updateAction(deptId: string, idx: number, value: string) {
    updateBlock(deptId, (b) => ({
      ...b,
      staff_actions: b.staff_actions.map((a, i) => (i === idx ? value : a)),
    }));
  }

  function removeAction(deptId: string, idx: number) {
    updateBlock(deptId, (b) => ({ ...b, staff_actions: b.staff_actions.filter((_, i) => i !== idx) }));
  }

  function addAction(deptId: string) {
    updateBlock(deptId, (b) => ({ ...b, staff_actions: [...b.staff_actions, ""] }));
  }

  function updateNotice(deptId: string, value: string) {
    updateBlock(deptId, (b) => ({ ...b, guest_notice: value }));
  }

  function removeRecipient(deptId: string, employeeId: string) {
    updateBlock(deptId, (b) => ({ ...b, recipients: b.recipients.filter((r) => r.employee_id !== employeeId) }));
  }

  function addRecipient(deptId: string, employeeId: string) {
    const candidate = (candidatesByDept[deptId] ?? []).find((c) => c.employee_id === employeeId);
    if (!candidate) return;
    updateBlock(deptId, (b) =>
      b.recipients.some((r) => r.employee_id === employeeId) ? b : { ...b, recipients: [...b.recipients, candidate] },
    );
  }

  function toggleRecipientEditor() {
    if (editingDeptId) {
      setEditingDeptId(null);
      return;
    }
    const first = content.find((b) => b.selected) ?? content[0];
    if (first) setEditingDeptId(first.department_id);
  }

  async function handleApprove() {
    if (!event) return;
    setSending(true);
    setActionError(null);
    setBanner(null);
    try {
      const res = await callSend({ mode: "approve", event_id: event.id, content });
      if (res.fail_count && res.fail_count > 0) {
        setEvent((ev) => (ev ? { ...ev, status: "ACTIVE" } : ev));
        setBanner({ type: "danger", text: `${res.fail_count}명 발송 실패 — 발송 이력에서 확인하세요.` });
      } else {
        navigate("/history");
      }
    } catch {
      setActionError("승인 및 발송에 실패했습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.");
    } finally {
      setSending(false);
    }
  }

  async function handleSaveDraft() {
    if (!messageId) return;
    setSavingDraft(true);
    setActionError(null);
    setBanner(null);
    const { error } = await supabase
      .from("messages")
      .update({ content, updated_at: new Date().toISOString(), updated_by: employee?.id ?? null })
      .eq("id", messageId);
    setSavingDraft(false);
    if (error) setActionError("임시 저장에 실패했습니다.");
    else setBanner({ type: "info", text: "임시 저장되었습니다." });
  }

  async function handleDismissConfirmed() {
    if (!event) return;
    setDismissing(true);
    setActionError(null);
    try {
      await callSend({ mode: "dismiss", event_id: event.id });
      navigate("/");
    } catch {
      setActionError("무시 처리에 실패했습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.");
    } finally {
      setDismissing(false);
      setDismissModalOpen(false);
    }
  }

  if (authLoading) return null;

  const selectedCount = content.filter((b) => b.selected).length;
  const recipientCount = content
    .filter((b) => b.selected)
    .reduce((sum, b) => sum + b.recipients.length, 0);
  const allSelected = content.length > 0 && content.every((b) => b.selected);

  const summaryText = content
    .filter((b) => b.selected && b.recipients.length > 0)
    .map((b) => `${b.recipients.map((r) => r.name).join(", ")} (${b.department_name})`)
    .join(" · ");

  const editingBlock = content.find((b) => b.department_id === editingDeptId) ?? null;
  const candidates = editingBlock
    ? (candidatesByDept[editingBlock.department_id] ?? []).filter(
        (c) => !editingBlock.recipients.some((r) => r.employee_id === c.employee_id),
      )
    : [];

  const primaryMetric = event ? KIND_METRICS[event.kind][0] : null;
  let metaLine = "";
  if (event) {
    metaLine = `오늘 ${formatHM(event.detected_at)} 감지`;
    if (observation && primaryMetric) {
      const obsVal = primaryMetric.key === "daily_accum" ? dailyAccum : observation[primaryMetric.key as NumericObsKey];
      metaLine += ` · 트리거 ${primaryMetric.label} ${formatNum(obsVal)}${primaryMetric.unit}`;
      const thresholdKey = TRIGGER_THRESHOLD_KEY[event.kind];
      const thresholdVal = criteria?.threshold?.[thresholdKey];
      if (typeof thresholdVal === "number") metaLine += ` (기준 ${thresholdVal}${primaryMetric.unit})`;
    }
    metaLine += " · 초안은 등록된 부서 지침으로 자동 작성되었습니다";
  }

  return (
    <AppLayout
      title={event ? `${KIND_LABEL[event.kind]} ${GRADE_LABEL[event.grade]} · 초안 검토` : "초안 검토"}
      actions={
        event ? <span className={`status-tag ${STATUS_CLASS[event.status]}`}>{STATUS_LABEL[event.status]}</span> : undefined
      }
    >
      {loading && <p className="review-loading">불러오는 중…</p>}

      {!loading && loadError && (
        <EmptyState icon={<IconCloud />} title="이벤트를 찾을 수 없습니다" desc={loadError} />
      )}

      {!loading && !loadError && event && (
        <>
          <p className="review-meta">{metaLine}</p>
          <Link to="/" className="review-back">
            ← 대시보드로 돌아가기
          </Link>

          {banner && (
            <div className={`review-banner ${banner.type === "danger" ? "review-banner-danger" : "review-banner-info"}`}>
              {banner.text}
            </div>
          )}
          {actionError && <div className="review-banner review-banner-danger">{actionError}</div>}

          <div className="review-grid">
            <div className="review-main">
              {canEdit ? (
                <div className="review-selectall">
                  <label className="review-selectall-left">
                    <input
                      type="checkbox"
                      className="review-checkbox"
                      checked={allSelected}
                      aria-label="전체 선택"
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                    />
                    전체 선택
                    <span className="review-selectall-count">
                      {selectedCount}개 부서 · 수신자 {recipientCount}명
                    </span>
                  </label>
                  <span className="review-hint">블록을 클릭하면 내용을 수정할 수 있습니다</span>
                </div>
              ) : (
                <p className="review-hint" style={{ marginBottom: 16 }}>
                  {content.length}개 부서 · 수신자{" "}
                  {content.reduce((sum, b) => sum + b.recipients.length, 0)}명
                </p>
              )}

              {content.length === 0 && (
                <p className="review-hint">구성된 부서 지침이 없습니다.</p>
              )}

              {content.map((block) => (
                <DeptBlockCard
                  key={block.department_id}
                  block={block}
                  grade={event.grade}
                  canEdit={canEdit}
                  isEditing={canEdit && editingDeptId === block.department_id}
                  isOwn={isOwnDept(block)}
                  onCardClick={(e) => {
                    if (isInteractiveTarget(e)) return;
                    setEditingDeptId(block.department_id);
                  }}
                  onToggleSelected={(checked) => toggleBlockSelected(block.department_id, checked)}
                  onOpenEdit={(e) => {
                    e.stopPropagation();
                    setEditingDeptId(block.department_id);
                  }}
                  onCloseEdit={(e) => {
                    e.stopPropagation();
                    setEditingDeptId(null);
                  }}
                  onUpdateAction={(idx, value) => updateAction(block.department_id, idx, value)}
                  onRemoveAction={(idx) => removeAction(block.department_id, idx)}
                  onAddAction={() => addAction(block.department_id)}
                  onUpdateNotice={(value) => updateNotice(block.department_id, value)}
                />
              ))}
            </div>

            <div className="review-rail">
              <div className="rail-card rail-obs-card">
                <div className="rail-obs-title">
                  <IconCloud />
                  트리거 관측값 · {observation ? formatHM(observation.observed_at) : "-"}
                </div>
                <div className="rail-obs-grid">
                  {KIND_METRICS[event.kind].map((m, idx) => (
                    <div key={m.key}>
                      <div className="rail-obs-item-label">{m.label}</div>
                      <div className={`rail-obs-item-value ${idx === 0 ? "rail-obs-highlight" : ""}`}>
                        {formatNum(
                          m.key === "daily_accum" ? dailyAccum : observation ? observation[m.key as NumericObsKey] : null,
                        )}
                        <span style={{ fontSize: 13, fontWeight: 400, marginLeft: 2 }}>{m.unit}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rail-card">
                <h2 className="rail-title">발송 설정</h2>

                <p className="rail-label">발송 채널</p>
                <div className="rail-channel rail-channel-active">
                  <span className="rail-channel-icon" aria-hidden="true">
                    💬
                  </span>
                  카카오워크 봇
                  <span className="rail-channel-check" aria-hidden="true">
                    ✓
                  </span>
                </div>
                <div className="rail-channel rail-channel-disabled">
                  <span>SMS · 알림톡</span>
                  <span className="rail-channel-disabled-note">채널 미연동</span>
                </div>

                <div className="rail-label rail-recipients-row">
                  <span className="rail-recipients-count">수신자 · {recipientCount}명</span>
                  {canEdit && (
                    <button type="button" className="rail-recipients-toggle" onClick={toggleRecipientEditor}>
                      수신자 가감
                    </button>
                  )}
                </div>
                <p className="rail-recipients-summary">{summaryText || "선택된 수신자가 없습니다"}</p>

                {canEdit && editingBlock && (
                  <div className="rail-recipients-editor">
                    <p className="rail-recipients-editor-dept">{editingBlock.department_name} 수신자</p>
                    <div className="rail-chip-row">
                      {editingBlock.recipients.map((r) => (
                        <Chip
                          key={r.employee_id}
                          label={r.name}
                          onRemove={() => removeRecipient(editingBlock.department_id, r.employee_id)}
                        />
                      ))}
                    </div>
                    {candidates.length > 0 && (
                      <div className="rail-add-recipient">
                        <select
                          value={pendingCandidate}
                          aria-label={`${editingBlock.department_name} 수신자 추가`}
                          onChange={(e) => setPendingCandidate(e.target.value)}
                        >
                          <option value="">추가할 수신자 선택</option>
                          {candidates.map((c) => (
                            <option key={c.employee_id} value={c.employee_id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (!pendingCandidate) return;
                            addRecipient(editingBlock.department_id, pendingCandidate);
                            setPendingCandidate("");
                          }}
                          disabled={!pendingCandidate}
                        >
                          추가
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <p className="rail-repeat-caption">
                  <IconRepeat />
                  {repeatPolicyCaption(alertSetting)}
                </p>
              </div>

              <div className="rail-card">
                {canEdit ? (
                  <>
                    <div className="rail-cta">
                      <Button
                        variant="hero"
                        onClick={handleApprove}
                        disabled={sending || selectedCount === 0}
                      >
                        <IconSend /> 승인 및 발송
                      </Button>
                    </div>
                    <p className="rail-cta-note">발송 즉시 선택된 {selectedCount}개 부서 담당자에게 전달됩니다</p>
                    <div className="rail-secondary-actions">
                      <Button variant="ghost" onClick={handleSaveDraft} disabled={savingDraft}>
                        임시 저장
                      </Button>
                      <div className="rail-dismiss-wrap">
                        <Button variant="ghost" onClick={() => setDismissModalOpen(true)} disabled={dismissing}>
                          특보 무시
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="review-hint">현재 화면은 읽기 전용입니다.</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {dismissModalOpen && (
        <Modal
          title="이 특보를 무시할까요?"
          desc="무시하면 이 특보는 종료 처리되며 어떤 부서에도 발송되지 않습니다. 이 작업은 되돌릴 수 없습니다."
          onClose={() => setDismissModalOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDismissModalOpen(false)}>
                취소
              </Button>
              <Button variant="primary" onClick={handleDismissConfirmed} disabled={dismissing}>
                무시하기
              </Button>
            </>
          }
        />
      )}
    </AppLayout>
  );
}
