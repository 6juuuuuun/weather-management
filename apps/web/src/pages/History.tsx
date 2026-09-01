import { useEffect, useMemo, useState } from "react";
import { AppLayout } from "../components/AppLayout";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { StatusDot } from "../components/StatusDot";
import { EmptyState } from "../components/EmptyState";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../lib/api/client";
import { dispatches as fetchDispatches } from "../lib/api/content";
import type { DispatchRow as DispatchRowApi } from "../lib/api/content";
import { callSend } from "../lib/api/send";
import type { DeptBlock, DispatchResult, Grade, Kind } from "../lib/types";
import "./History.css";

const KIND_LABEL: Record<Kind, string> = { rain: "폭우", snow: "폭설", wind: "강풍", heat: "폭염" };
const KIND_OPTIONS: { value: Kind | "all"; label: string }[] = [
  { value: "all", label: "특보: 전체" },
  { value: "rain", label: "폭우" },
  { value: "snow", label: "폭설" },
  { value: "wind", label: "강풍" },
  { value: "heat", label: "폭염" },
];
const GRADE_OPTIONS: { value: Grade | "all"; label: string }[] = [
  { value: "all", label: "등급: 전체" },
  { value: "watch", label: "주의보" },
  { value: "warning", label: "경보" },
];
const PERIOD_OPTIONS: { value: string; label: string; days: number | null }[] = [
  { value: "7", label: "기간: 최근 7일", days: 7 },
  { value: "30", label: "기간: 최근 30일", days: 30 },
  { value: "90", label: "기간: 최근 90일", days: 90 },
  { value: "all", label: "기간: 전체", days: null },
];

const PAGE_SIZE = 20;

type DispatchRow = {
  id: number;
  message_id: string;
  event_id: string;
  sent_at: string;
  channel: string;
  repeat_no: number;
  is_test: boolean;
  results: DispatchResult[];
  kind: Kind;
  grade: Grade;
  detected_at: string;
  content: DeptBlock[];
  event_status: DispatchRowApi["event_status"];
  message_status: DispatchRowApi["message_status"];
};

// 재발송이 허용되는 상태(server/src/jobs/send.ts의 resend 게이트와 같은 조건).
// 이미 해제·격상·무시된 특보를 다시 보내면 obs_line이 그 특보의 트리거 관측이므로
// **지난주 값이 "현재 관측"으로** 나간다 — 받는 사람은 지금 비가 온다는 뜻으로 읽는다.
function canResendRow(row: { event_status: string; message_status: string }): boolean {
  return (
    (row.event_status === "PENDING_APPROVAL" || row.event_status === "ACTIVE") &&
    row.message_status === "approved"
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDetected(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatSentTime(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function recipientSummary(content: DeptBlock[]): string {
  const selected = content.filter((b) => b.selected);
  if (selected.length === 0) return "수신처 없음";
  const total = selected.reduce((sum, b) => sum + b.recipients.length, 0);
  const first = selected[0].department_name;
  const extra = selected.length - 1;
  const deptPart = extra > 0 ? `${first} 외 ${extra}곳` : first;
  return `${deptPart} · ${total}명`;
}

// "10명에게 성공"과 "0명에게 성공"이 화면에서 구분되지 않았다(QA W-02). results가 빈
// 배열이면 실패한 사람이 없어서가 아니라 **대상이 아무도 없어서**다 — 그 발송은
// 초록색 성공이 아니라 아무 일도 일어나지 않은 발송이다.
function statusSummary(results: DispatchResult[]): { ok: boolean; label: string } {
  if (results.length === 0) return { ok: false, label: "수신자 0명" };
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  if (failCount > 0) return { ok: false, label: `실패 ${failCount} · 성공 ${okCount}` };
  return { ok: true, label: `성공 ${okCount}` };
}

function cloneContent(content: DeptBlock[]): DeptBlock[] {
  return content.map((b) => ({
    ...b,
    staff_actions: [...b.staff_actions],
    recipients: b.recipients.map((r) => ({ ...r })),
  }));
}

export default function History() {
  // 재발송도 승인과 같은 서버 게이트(alert_recipients)를 타므로 역할이 아니라 isApprover로 판정한다.
  // 서버가 최종 게이트이므로 이 값은 화면 노출 제어용이다.
  const { isApprover: canResend } = useAuth();

  const [rows, setRows] = useState<DispatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<Kind | "all">("all");
  const [gradeFilter, setGradeFilter] = useState<Grade | "all">("all");
  const [periodFilter, setPeriodFilter] = useState("30");
  const [page, setPage] = useState(1);

  const [selected, setSelected] = useState<DispatchRow | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState<DeptBlock[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      // GET /api/dispatches는 include_test를 안 보내면(기본값) 테스트 발송을 이미 제외한다 —
      // 예전의 .eq("is_test", false)와 같은 기본값이므로 클라이언트에서 다시 거르지 않는다.
      // weather_events(kind/grade/detected_at)와 message_content(스냅샷 폴백)도 서버가 조인해 내려준다.
      const data = await fetchDispatches({ limit: 500 });
      const mapped = data.map((d) => ({
        id: d.id,
        message_id: d.message_id,
        event_id: d.event_id,
        sent_at: d.sent_at,
        channel: d.channel,
        repeat_no: d.repeat_no,
        is_test: d.is_test,
        results: d.results,
        kind: d.kind,
        grade: d.grade,
        detected_at: d.detected_at,
        event_status: d.event_status,
        message_status: d.message_status,
        // 발송 시점 스냅샷 우선, 스냅샷 이전(0004 마이그레이션 이전) 이력은 message_content로 폴백
        content: d.content ?? d.message_content ?? [],
      }));
      setRows(mapped);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "발송 이력을 불러오지 못했습니다");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [search, kindFilter, gradeFilter, periodFilter]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const period = PERIOD_OPTIONS.find((p) => p.value === periodFilter);
    const cutoff = period?.days != null ? Date.now() - period.days * 24 * 60 * 60 * 1000 : null;
    return rows.filter((r) => {
      if (kindFilter !== "all" && r.kind !== kindFilter) return false;
      if (gradeFilter !== "all" && r.grade !== gradeFilter) return false;
      if (cutoff != null && new Date(r.sent_at).getTime() < cutoff) return false;
      if (term) {
        const kindLabel = KIND_LABEL[r.kind].toLowerCase();
        const deptNames = r.content
          .filter((b) => b.selected)
          .map((b) => b.department_name.toLowerCase())
          .join(" ");
        if (!kindLabel.includes(term) && !deptNames.includes(term)) return false;
      }
      return true;
    });
  }, [rows, search, kindFilter, gradeFilter, periodFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const rangeStart = filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(filtered.length, page * PAGE_SIZE);

  function openModal(row: DispatchRow) {
    setSelected(row);
    setEditMode(false);
    setEditContent(cloneContent(row.content));
    setSendError(null);
  }

  function closeModal() {
    setSelected(null);
    setEditMode(false);
    setSendError(null);
  }

  function toggleBlockSelected(idx: number) {
    setEditContent((prev) =>
      prev.map((b, i) => (i === idx ? { ...b, selected: !b.selected } : b)),
    );
  }

  function updateStaffActions(idx: number, text: string) {
    setEditContent((prev) =>
      prev.map((b, i) =>
        i === idx ? { ...b, staff_actions: text.split("\n").filter((line) => line.trim() !== "") } : b,
      ),
    );
  }

  function updateGuestNotice(idx: number, text: string) {
    setEditContent((prev) => prev.map((b, i) => (i === idx ? { ...b, guest_notice: text } : b)));
  }

  async function submitResend(messageId: string, content: DeptBlock[]) {
    setSending(true);
    setSendError(null);
    try {
      const result = await callSend({ mode: "resend", message_id: messageId, content });
      if (!result.ok) {
        setSendError(result.error ?? "재발송에 실패했습니다");
        return;
      }
      closeModal();
      await load();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "재발송에 실패했습니다");
    } finally {
      setSending(false);
    }
  }

  async function quickResend(row: DispatchRow, e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm("현재 내용 그대로 재발송하시겠습니까?")) return;
    await submitResend(row.message_id, row.content);
  }

  return (
    <AppLayout title="발송 이력">
      <p className="history-lead">
        발송된 모든 메시지의 이력입니다. 행을 클릭하면 발송 당시 원본 메시지를 확인하고 재발송할 수
        있습니다
      </p>

      <div className="history-filters">
        <div className="history-search">
          <svg
            className="history-search-icon"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" strokeWidth="1.5" />
            <path d="M20 20l-3.5-3.5" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            placeholder="특보 · 수신처 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="특보 · 수신처 검색"
          />
        </div>

        <label className="history-select">
          <select
            aria-label="특보 종류"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as Kind | "all")}
          >
            {KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.value === "all" ? opt.label : `특보: ${opt.label}`}
              </option>
            ))}
          </select>
        </label>

        <label className="history-select">
          <select
            aria-label="등급"
            value={gradeFilter}
            onChange={(e) => setGradeFilter(e.target.value as Grade | "all")}
          >
            {GRADE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.value === "all" ? opt.label : `등급: ${opt.label}`}
              </option>
            ))}
          </select>
        </label>

        <label className="history-select">
          <select
            aria-label="기간"
            value={periodFilter}
            onChange={(e) => setPeriodFilter(e.target.value)}
          >
            {PERIOD_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loadError && <p className="history-error">발송 이력을 불러오지 못했습니다: {loadError}</p>}

      {!loading && !loadError && filtered.length === 0 ? (
        <EmptyState
          icon={
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="28" height="28">
              <path
                d="M4 5h16v14H4z M4 9h16 M8 3v4 M16 3v4"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
          title="발송 이력이 없습니다"
          desc="검색·필터 조건에 맞는 발송 이력이 없습니다"
        />
      ) : (
        <div className="history-table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th className="col-no">번호</th>
                <th className="col-kind">특보</th>
                <th className="col-detected">특보 발생</th>
                <th className="col-sent">메시지 발송</th>
                <th className="col-recipients">수신처</th>
                <th className="col-status">상태</th>
                <th className="col-repeat">반복</th>
                <th className="col-action" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const status = statusSummary(row.results);
                return (
                  <tr key={row.id} onClick={() => openModal(row)} className="history-row">
                    <td className="col-no">{row.id}</td>
                    <td className="col-kind">
                      <span className="history-kind-label">{KIND_LABEL[row.kind]}</span>
                      <Badge grade={row.grade} />
                    </td>
                    <td className="col-detected">{formatDetected(row.detected_at)}</td>
                    <td className="col-sent">{formatSentTime(row.sent_at)}</td>
                    <td className="col-recipients">{recipientSummary(row.content)}</td>
                    <td className="col-status">
                      <StatusDot ok={status.ok} label={status.label} />
                    </td>
                    <td className="col-repeat">{row.repeat_no}회차</td>
                    <td className="col-action">
                      {canResend && !row.is_test && canResendRow(row) && (
                        <button
                          type="button"
                          className="history-resend-btn"
                          onClick={(e) => quickResend(row, e)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <path
                              d="M4 12a8 8 0 1 1 2.3 5.6M4 12V6m0 6h6"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          재발송
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="history-pagination">
            <span className="history-pagination-count">
              총 {filtered.length}건 중 {rangeStart}–{rangeEnd}
            </span>
            <div className="history-pagination-nav">
              <button
                type="button"
                className="history-page-btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="이전 페이지"
              >
                ‹
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`history-page-btn ${p === page ? "history-page-btn-active" : ""}`}
                  onClick={() => setPage(p)}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                className="history-page-btn"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                aria-label="다음 페이지"
              >
                ›
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="history-footnote">
        ⓘ 행 클릭 시 발송 당시 원본 메시지가 열립니다 · 재발송과 수정 발송은 Alert 수신자 권한입니다
      </p>

      {/* 목록의 빠른 재발송은 모달을 열지 않는다. sendError를 모달 안에서만 그리면
          그 경로의 실패(예: alert_recipients가 아니어서 403)는 화면에 아무 흔적도
          남기지 않는다 — 사용자는 재발송이 된 줄 안다. 모달이 닫혀 있을 때는 여기 띄운다. */}
      {!selected && sendError && <p className="history-error">{sendError}</p>}

      {selected && (
        <Modal
          title={`${KIND_LABEL[selected.kind]} ${selected.grade === "watch" ? "주의보" : "경보"} · ${
            editMode ? "수정 후 재발송" : "발송 내용"
          }`}
          desc={`${formatDetected(selected.detected_at)} 감지 · ${selected.repeat_no}회차 발송 · ${formatSentTime(
            selected.sent_at,
          )} 발송`}
          onClose={closeModal}
          footer={
            editMode ? (
              <>
                <Button variant="ghost" onClick={() => setEditMode(false)} disabled={sending}>
                  취소
                </Button>
                <Button
                  variant="primary"
                  disabled={sending}
                  onClick={() => submitResend(selected.message_id, editContent)}
                >
                  {sending ? "재발송 중…" : "재발송"}
                </Button>
              </>
            ) : (
              canResend &&
              !selected.is_test &&
              (canResendRow(selected) ? (
                <Button variant="primary" onClick={() => setEditMode(true)}>
                  수정 후 재발송
                </Button>
              ) : (
                <p className="history-footnote">
                  이미 종료된 특보라 재발송할 수 없습니다 — 그때의 관측값이 "현재 관측"으로 나갑니다.
                </p>
              ))
            )
          }
        >
          {sendError && <p className="history-error">{sendError}</p>}

          <div className="history-block-list">
            {(editMode ? editContent : selected.content).map((block, idx) => (
              <div key={block.department_id} className={`history-block ${block.selected ? "" : "history-block-off"}`}>
                <div className="history-block-header">
                  {editMode ? (
                    <label className="history-block-check">
                      <input
                        type="checkbox"
                        checked={block.selected}
                        onChange={() => toggleBlockSelected(idx)}
                      />
                      <span>{block.department_name}</span>
                    </label>
                  ) : (
                    <span className="history-block-dept">{block.department_name}</span>
                  )}
                  <Badge grade={selected.grade} />
                </div>

                {editMode ? (
                  <textarea
                    className="history-block-textarea"
                    value={block.staff_actions.join("\n")}
                    onChange={(e) => updateStaffActions(idx, e.target.value)}
                    rows={Math.max(2, block.staff_actions.length)}
                  />
                ) : (
                  <ul className="history-block-actions">
                    {block.staff_actions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}

                {editMode ? (
                  <div className="history-block-notice-edit">
                    <span className="history-block-notice-label">고객 안내 멘트</span>
                    <textarea
                      className="history-block-textarea"
                      value={block.guest_notice}
                      onChange={(e) => updateGuestNotice(idx, e.target.value)}
                      rows={2}
                    />
                  </div>
                ) : (
                  block.guest_notice && (
                    <div className="history-block-notice">
                      <span className="history-block-notice-label">고객 안내 멘트</span>
                      <p>{block.guest_notice}</p>
                    </div>
                  )
                )}

                <div className="history-block-recipients">
                  수신 {block.recipients.map((r) => r.name).join(", ") || "없음"}
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </AppLayout>
  );
}
