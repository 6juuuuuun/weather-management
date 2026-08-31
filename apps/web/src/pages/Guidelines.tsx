import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppLayout } from "../components/AppLayout";
import { FilterPill } from "../components/FilterPill";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../lib/api/client";
import { listDepartments, listEmployees, listRecipients, saveRecipients } from "../lib/api/org";
import type { DepartmentRow, EmployeeRow, RecipientRow } from "../lib/api/org";
import { guidelines as fetchGuidelines, saveGuidelines } from "../lib/api/content";
import type { GuidelineRow } from "../lib/api/content";
import type { Grade, Kind } from "../lib/types";
import { ROLE_LABEL } from "../lib/roles";
import "./Guidelines.css";

const KINDS: Kind[] = ["rain", "snow", "wind", "heat"];
const KIND_LABEL: Record<Kind, string> = { rain: "폭우", snow: "폭설", wind: "강풍", heat: "폭염" };
const GRADES: Grade[] = ["watch", "warning"];
const GRADE_LABEL: Record<Grade, string> = { watch: "주의보", warning: "경보" };

function DeptIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="9" y="3" width="6" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="15" width="6" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="15" y="15" width="6" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 8v3m0 0H6v4m6-4h6v4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatDate(iso: string): string {
  // ko-KR의 numeric 포맷은 "8. 15."처럼 마침표가 붙어 문장 끝처럼 읽힌다. "8월 15일"로 쓴다.
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function editBufferFor(
  deptId: string,
  grade: Grade,
  kind: Kind,
  guidelines: GuidelineRow[],
  recipients: RecipientRow[],
) {
  const guideline = guidelines.find(
    (g) => g.department_id === deptId && g.kind === kind && g.grade === grade,
  );
  return {
    staffActions: guideline?.staff_actions ?? [],
    guestNotice: guideline?.guest_notice ?? "",
    recipientIds: recipients.filter((r) => r.department_id === deptId).map((r) => r.employee_id),
  };
}

export default function Guidelines() {
  const { employee } = useAuth();
  const isAdmin = employee?.role === "admin";

  const [loading, setLoading] = useState(true);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [guidelines, setGuidelines] = useState<GuidelineRow[]>([]);

  const [kind, setKind] = useState<Kind>("rain");
  const [grade, setGrade] = useState<Grade>("watch");
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const [staffActions, setStaffActions] = useState<string[]>([]);
  const [guestNotice, setGuestNotice] = useState("");
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // 초기 로드: 부서·직원·수신자·지침 (전 역할 조회 가능, staff도 자기 부서 지침은 서버가 내려준다)
  // GET /api/guidelines는 kind로 거르지 않고 전체를 내려준다 — 종류 탭을 바꿔도 다시
  // 조회하지 않고 이미 가진 목록에서 골라 쓴다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [depts, emps, recs, guides] = await Promise.all([
        listDepartments(),
        listEmployees(),
        listRecipients(),
        fetchGuidelines(),
      ]);
      if (cancelled) return;
      setDepartments(depts);
      setEmployees(emps);
      setRecipients(recs);
      setGuidelines(guides);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = (() => {
    const byParent = new Map<string, DepartmentRow[]>();
    const roots: DepartmentRow[] = [];
    for (const d of departments) {
      if (d.parent_id === null) {
        roots.push(d);
      } else {
        const arr = byParent.get(d.parent_id) ?? [];
        arr.push(d);
        byParent.set(d.parent_id, arr);
      }
    }
    roots.sort((a, b) => a.sort_order - b.sort_order);
    return roots.map((group) => ({
      group,
      leaves: (byParent.get(group.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order),
    }));
  })();

  // 부서 목록이 로드되면 첫 리프 부서를 기본 선택
  useEffect(() => {
    if (selectedDeptId) return;
    const firstLeaf = groups.flatMap((g) => g.leaves)[0];
    if (firstLeaf) setSelectedDeptId(firstLeaf.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departments]);

  // 선택된 부서·등급·종류가 바뀌면 편집 버퍼를 서버 상태로 초기화
  useEffect(() => {
    if (!selectedDeptId) {
      setStaffActions([]);
      setGuestNotice("");
      setRecipientIds([]);
      return;
    }
    const buf = editBufferFor(selectedDeptId, grade, kind, guidelines, recipients);
    setStaffActions(buf.staffActions);
    setGuestNotice(buf.guestNotice);
    setRecipientIds(buf.recipientIds);
    setSaveError(null);
  }, [selectedDeptId, grade, kind, guidelines, recipients]);

  function guidelineFor(deptId: string, g: Grade): GuidelineRow | undefined {
    return guidelines.find((item) => item.department_id === deptId && item.grade === g);
  }

  function recipientCountFor(deptId: string): number {
    return recipients.filter((r) => r.department_id === deptId).length;
  }

  function toggleGroup(id: string) {
    setCollapsedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function addBullet() {
    setStaffActions((prev) => [...prev, ""]);
  }

  function updateBullet(index: number, value: string) {
    setStaffActions((prev) => prev.map((item, i) => (i === index ? value : item)));
  }

  function removeBullet(index: number) {
    setStaffActions((prev) => prev.filter((_, i) => i !== index));
  }

  function removeRecipient(employeeId: string) {
    setRecipientIds((prev) => prev.filter((id) => id !== employeeId));
  }

  function addRecipient(employeeId: string) {
    setRecipientIds((prev) => (prev.includes(employeeId) ? prev : [...prev, employeeId]));
  }

  function handleCancel() {
    if (!selectedDeptId) return;
    const buf = editBufferFor(selectedDeptId, grade, kind, guidelines, recipients);
    setStaffActions(buf.staffActions);
    setGuestNotice(buf.guestNotice);
    setRecipientIds(buf.recipientIds);
    setSaveError(null);
  }

  async function handleSave() {
    if (!selectedDeptId || !employee) return;
    setSaving(true);
    setSaveError(null);
    try {
      const cleanedActions = staffActions.map((s) => s.trim()).filter((s) => s.length > 0);

      // PUT /api/guidelines는 department_id/kind/grade를 키로 upsert한다(서버가 updated_by를
      // current_emp_id()로 직접 채운다 — 클라이언트 값을 신뢰하지 않는다).
      await saveGuidelines([
        {
          department_id: selectedDeptId,
          kind,
          grade,
          staff_actions: cleanedActions,
          guest_notice: guestNotice,
        },
      ]);

      // PUT /api/recipients/:departmentId는 이 부서 몫을 통째로 교체한다 —
      // 예전의 delete-then-insert를 서버가 한 번에 해준다.
      await saveRecipients(selectedDeptId, recipientIds);

      const [freshGuidelines, freshRecipients] = await Promise.all([fetchGuidelines(), listRecipients()]);
      setGuidelines(freshGuidelines);
      setRecipients(freshRecipients);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  const selectedDept = departments.find((d) => d.id === selectedDeptId) ?? null;
  const selectedGroup = selectedDept
    ? (departments.find((d) => d.id === selectedDept.parent_id) ?? null)
    : null;
  const currentGuideline = selectedDeptId ? guidelineFor(selectedDeptId, grade) : undefined;
  const updaterName = currentGuideline?.updated_by
    ? employees.find((e) => e.id === currentGuideline.updated_by)?.name
    : undefined;
  const deptEmployees = selectedDeptId
    ? employees.filter((e) => e.department_id === selectedDeptId)
    : [];
  const searchResults = deptEmployees.filter((e) => {
    if (recipientIds.includes(e.id)) return false;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q);
  });

  return (
    <AppLayout title="행동 지침">
      <p className="guidelines-lead">
        특보 발생 시 각 부서가 이행할 지침을 사전에 등록합니다. 발송 초안은 이 지침을 조합해 자동 작성됩니다.
      </p>

      {loading ? (
        <p className="guidelines-loading">불러오는 중…</p>
      ) : departments.length === 0 ? (
        <EmptyState
          icon={<DeptIcon />}
          title="아직 등록된 부서가 없습니다"
          desc={
            isAdmin
              ? "행동 지침은 부서 단위로 작성됩니다. 직원 관리에서 부서를 먼저 구성해 주세요."
              : "행동 지침은 부서 단위로 작성됩니다. 관리자에게 부서 구성을 요청하세요."
          }
          cta={
            isAdmin ? (
              <Link to="/employees?dept=open" className="btn btn-primary">
                + 부서 관리 열기
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="guidelines-kind-tabs">
            {KINDS.map((k) => (
              <FilterPill key={k} selected={kind === k} label={KIND_LABEL[k]} onClick={() => setKind(k)} />
            ))}
          </div>

          <div className="guidelines-layout">
            <div className="guidelines-panel guidelines-tree">
              <div className="guidelines-tree-header">
                <h2>
                  부서 · {KIND_LABEL[kind]} 지침 등록 현황
                </h2>
                <div className="guidelines-legend">
                  <span className="legend-dot legend-watch" aria-hidden="true" />
                  주의보
                  <span className="legend-dot legend-warning" aria-hidden="true" />
                  경보
                </div>
              </div>

              <div className="guidelines-tree-body">
                {groups.map(({ group, leaves }) => (
                  <div key={group.id} className="guidelines-group">
                    <button
                      type="button"
                      className="guidelines-group-toggle"
                      onClick={() => toggleGroup(group.id)}
                      aria-expanded={!collapsedGroups[group.id]}
                    >
                      <span
                        className={`chevron ${collapsedGroups[group.id] ? "chevron-collapsed" : ""}`}
                        aria-hidden="true"
                      >
                        ⌄
                      </span>
                      {group.name}
                    </button>

                    {!collapsedGroups[group.id] &&
                      leaves.map((leaf) => {
                        const watchGuideline = guidelineFor(leaf.id, "watch");
                        const warningGuideline = guidelineFor(leaf.id, "warning");
                        const count = recipientCountFor(leaf.id);
                        return (
                          <button
                            type="button"
                            key={leaf.id}
                            className={`guidelines-leaf ${
                              selectedDeptId === leaf.id ? "guidelines-leaf-selected" : ""
                            }`}
                            onClick={() => setSelectedDeptId(leaf.id)}
                          >
                            <span className="guidelines-leaf-name">{leaf.name}</span>
                            <span className="guidelines-leaf-meta">
                              <span
                                className={`tree-dot ${watchGuideline ? "tree-dot-watch" : "tree-dot-empty"}`}
                                aria-hidden="true"
                              />
                              <span
                                className={`tree-dot ${warningGuideline ? "tree-dot-warning" : "tree-dot-empty"}`}
                                aria-hidden="true"
                              />
                              {count > 0 ? (
                                <span className="guidelines-count">{count}명</span>
                              ) : (
                                <span className="guidelines-unassigned">미지정</span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                ))}
              </div>
            </div>

            <div className="guidelines-panel guidelines-editor">
              {!selectedDept ? (
                <p className="guidelines-editor-empty">좌측에서 부서를 선택하세요.</p>
              ) : (
                <>
                  <div className="guidelines-editor-top">
                    <div>
                      <p className="guidelines-breadcrumb">
                        {selectedGroup ? `${selectedGroup.name} > ${selectedDept.name}` : selectedDept.name}
                      </p>
                      <div className="guidelines-editor-title-row">
                        <h2>{KIND_LABEL[kind]} 대응 지침</h2>
                        <div className="guidelines-grade-switch">
                          {GRADES.map((g) => (
                            <FilterPill
                              key={g}
                              selected={grade === g}
                              label={GRADE_LABEL[g]}
                              onClick={() => setGrade(g)}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                    {currentGuideline && (
                      <p className="guidelines-updated-meta">
                        마지막 수정 {formatDate(currentGuideline.updated_at)}
                        {updaterName ? ` · ${updaterName}` : ""}
                      </p>
                    )}
                  </div>

                  <section className="guidelines-section">
                    <div className="guidelines-section-header">
                      <h3>인력 조정 지침</h3>
                      {isAdmin && (
                        <button type="button" className="guidelines-add-link" onClick={addBullet}>
                          + 항목 추가
                        </button>
                      )}
                    </div>
                    {staffActions.length === 0 ? (
                      <p className="guidelines-section-empty">등록된 지침이 없습니다.</p>
                    ) : (
                      <ul className="guidelines-bullets">
                        {staffActions.map((text, i) => (
                          <li key={i} className="guidelines-bullet-row">
                            <span className="guidelines-drag-handle" aria-hidden="true">
                              ⠿
                            </span>
                            <input
                              className="guidelines-bullet-input"
                              value={text}
                              disabled={!isAdmin}
                              onChange={(e) => updateBullet(i, e.target.value)}
                              placeholder="지침 내용을 입력하세요"
                            />
                            {isAdmin && (
                              <button
                                type="button"
                                className="guidelines-bullet-remove"
                                aria-label="항목 삭제"
                                onClick={() => removeBullet(i)}
                              >
                                삭제
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="guidelines-section">
                    <h3>
                      고객 안내 멘트 <span className="guidelines-section-hint">고객에게 그대로 전달할 수 있는 안내문</span>
                    </h3>
                    <textarea
                      className="guidelines-textarea"
                      value={guestNotice}
                      disabled={!isAdmin}
                      onChange={(e) => setGuestNotice(e.target.value)}
                      rows={5}
                      placeholder="예: 안녕하세요, ○○리조트입니다. ..."
                    />
                  </section>

                  <section className="guidelines-section">
                    <h3>
                      수신 담당자 <span className="guidelines-section-hint">클릭하여 임직원 검색으로 지정</span>
                    </h3>
                    <div className="guidelines-recipients">
                      {recipientIds.map((id) => {
                        const emp = employees.find((e) => e.id === id);
                        if (!emp) return null;
                        return (
                          <Chip
                            key={id}
                            label={`${emp.name} · ${ROLE_LABEL[emp.role]}`}
                            onRemove={isAdmin ? () => removeRecipient(id) : undefined}
                          />
                        );
                      })}
                      {isAdmin && (
                        <button
                          type="button"
                          className="guidelines-add-recipient"
                          onClick={() => setSearchOpen(true)}
                        >
                          + 수신자 추가
                        </button>
                      )}
                    </div>
                  </section>

                  {saveError && <p className="guidelines-error">{saveError}</p>}

                  {isAdmin && (
                    <div className="guidelines-footer">
                      <Button variant="ghost" onClick={handleCancel} disabled={saving}>
                        취소
                      </Button>
                      <Button variant="primary" onClick={handleSave} disabled={saving}>
                        {saving ? "저장 중…" : "지침 저장"}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {searchOpen && selectedDept && (
        <Modal
          title="수신자 추가"
          desc={`${selectedDept.name} 소속 직원 검색`}
          onClose={() => {
            setSearchOpen(false);
            setSearchQuery("");
          }}
        >
          <input
            className="guidelines-search-input"
            autoFocus
            placeholder="이름 또는 이메일 검색"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <ul className="guidelines-search-results">
            {searchResults.length === 0 ? (
              <li className="guidelines-search-empty">
                {deptEmployees.length === 0 ? "이 부서에 소속된 직원이 없습니다." : "검색 결과가 없습니다."}
              </li>
            ) : (
              searchResults.map((emp) => (
                <li key={emp.id}>
                  <button
                    type="button"
                    className="guidelines-search-result"
                    onClick={() => addRecipient(emp.id)}
                  >
                    <span>{emp.name}</span>
                    <span className="guidelines-search-result-email">{emp.email}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </Modal>
      )}
    </AppLayout>
  );
}
