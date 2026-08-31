import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppLayout } from "../components/AppLayout";
import { Button } from "../components/Button";
import { FilterPill } from "../components/FilterPill";
import { Modal } from "../components/Modal";
import { StatusDot } from "../components/StatusDot";
import { DeptModal } from "../components/DeptModal";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../lib/api/client";
import { listDepartments, listEmployees, updateEmployee, deleteEmployee as deleteEmployeeApi, createEmployee } from "../lib/api/org";
import type { DepartmentRow, EmployeeRow } from "../lib/api/org";
import type { EmpRole } from "../lib/types";
import { ROLE_LABEL } from "../lib/roles";
import "./Employees.css";

const ROLE_ORDER: EmpRole[] = ["admin", "approver", "staff"];

type ToastState = { kind: "ok" | "error"; message: string } | null;

type EmployeeFormState = {
  id: string | null;
  name: string;
  email: string;
  department_id: string | null;
  role: EmpRole;
};

const EMPTY_FORM: EmployeeFormState = { id: null, name: "", email: "", department_id: null, role: "staff" };

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  );
}

export default function Employees() {
  const { employee: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const [searchParams, setSearchParams] = useSearchParams();

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [unassignedOnly, setUnassignedOnly] = useState(false);

  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<EmployeeFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [deptModalOpen, setDeptModalOpen] = useState(searchParams.get("dept") === "open" && isAdmin);
  const [toast, setToast] = useState<ToastState>(null);

  async function loadAll() {
    const [emps, depts] = await Promise.all([listEmployees(), listDepartments()]);
    // employees API는 정렬 순서를 강제하지 않는다(org.ts: order by name) — 화면은
    // "최근 가입 우선"을 기대했으므로 created_at 내림차순으로 다시 정렬한다.
    setEmployees([...emps].sort((a, b) => b.created_at.localeCompare(a.created_at)));
    setDepartments(depts);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // departments API는 id/name만 내려준다(parent_id 없음) — 예전처럼 "상위 · 하위"로
  // 묶어 보여줄 수 없어 평면 목록으로 대체한다. task-8-report.md 참고.
  const deptById = useMemo(() => {
    const map = new Map<string, DepartmentRow>();
    for (const d of departments) map.set(d.id, d);
    return map;
  }, [departments]);

  const deptLabel = useMemo(() => {
    return (id: string | null): string => {
      if (!id) return "미지정";
      return deptById.get(id)?.name ?? "미지정";
    };
  }, [deptById]);

  const deptOptions = useMemo(
    () => departments.map((d) => ({ id: d.id, label: d.name })),
    [departments],
  );

  const unassignedCount = useMemo(
    () => employees.filter((e) => e.department_id === null).length,
    [employees],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (unassignedOnly && e.department_id !== null) return false;
      if (!unassignedOnly && deptFilter !== "all" && e.department_id !== deptFilter) return false;
      if (roleFilter !== "all" && e.role !== roleFilter) return false;
      if (q) {
        const hay = `${e.name} ${e.email} ${deptLabel(e.department_id)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [employees, search, deptFilter, roleFilter, unassignedOnly, deptLabel]);

  function openAdd() {
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEdit(e: EmployeeRow) {
    setForm({ id: e.id, name: e.name, email: e.email, department_id: e.department_id, role: e.role });
    setFormOpen(true);
  }

  async function submitForm() {
    if (!form.name.trim() || !form.email.trim()) {
      setToast({ kind: "error", message: "이름과 이메일을 입력하세요" });
      return;
    }
    setSaving(true);
    try {
      if (form.id) {
        // PATCH /api/employees/:id는 name/role/department_id/phone만 받는다 — email은
        // 서버가 갱신 대상으로 취급하지 않는다(org.ts). 여기서 보내도 조용히 무시된다.
        await updateEmployee(form.id, {
          name: form.name.trim(),
          department_id: form.department_id,
          role: form.role,
        });
        setToast({ kind: "ok", message: "직원 정보를 수정했습니다" });
      } else {
        // 서버에 직원 생성 엔드포인트가 없다(가입은 /api/auth/signup 전용) —
        // 이 호출은 이 엔드포인트가 생기기 전까지 404로 실패한다. task-8-report.md 참고.
        await createEmployee({
          name: form.name.trim(),
          email: form.email.trim(),
          department_id: form.department_id,
          role: form.role,
        });
        setToast({ kind: "ok", message: "직원을 추가했습니다" });
      }
      setFormOpen(false);
      await loadAll();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof ApiError ? err.message : "저장에 실패했습니다" });
    } finally {
      setSaving(false);
    }
  }

  async function deleteEmployee(e: EmployeeRow) {
    const ok = window.confirm(
      `${e.name} 님을 삭제하시겠습니까?\n지침 수신자 지정에서도 함께 제외됩니다.`,
    );
    if (!ok) return;
    try {
      await deleteEmployeeApi(e.id);
      setToast({ kind: "ok", message: "직원을 삭제했습니다" });
      await loadAll();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof ApiError ? err.message : "삭제에 실패했습니다" });
    }
  }

  async function assignDept(employeeId: string, departmentId: string) {
    try {
      await updateEmployee(employeeId, { department_id: departmentId || null });
      setAssigningId(null);
      await loadAll();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof ApiError ? err.message : "배정에 실패했습니다" });
    }
  }

  function closeDeptModal() {
    setDeptModalOpen(false);
    if (searchParams.get("dept")) {
      const next = new URLSearchParams(searchParams);
      next.delete("dept");
      setSearchParams(next, { replace: true });
    }
  }

  return (
    <AppLayout
      title="직원 관리"
      actions={
        isAdmin ? (
          <>
            <Button variant="ghost" onClick={() => setDeptModalOpen(true)}>
              부서 편집
            </Button>
            <Button variant="primary" onClick={openAdd}>
              직원 추가
            </Button>
          </>
        ) : undefined
      }
    >
      <p className="employees-intro">
        수신자 지정과 로그인 계정의 기준이 되는 직원 정보입니다 · {isAdmin ? "시스템 관리자 전용" : "읽기 전용"}
      </p>

      <div className="employees-filters">
        <span className="employees-search">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" strokeWidth="1.5" />
            <path d="m20 20-4.3-4.3" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            placeholder="이름 · 부서 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </span>

        <select
          className="employees-select-pill"
          value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value)}
          aria-label="부서 필터"
        >
          <option value="all">부서: 전체</option>
          {deptOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>

        <select
          className="employees-select-pill"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          aria-label="역할 필터"
        >
          <option value="all">역할: 전체</option>
          {ROLE_ORDER.map((r) => (
            <option key={r} value={r}>
              역할: {ROLE_LABEL[r]}
            </option>
          ))}
        </select>

        <FilterPill
          selected={unassignedOnly}
          label="부서 미지정"
          count={unassignedCount}
          onClick={() => setUnassignedOnly((v) => !v)}
        />
      </div>

      {loading ? (
        <p className="employees-loading">불러오는 중…</p>
      ) : (
        <div className="employees-table-wrap">
          <table className="employees-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>부서</th>
                <th>역할</th>
                <th>이메일</th>
                <th>카카오워크</th>
                <th aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const unassigned = e.department_id === null;
                return (
                  <tr key={e.id}>
                    <td>
                      <div className="employees-name">{e.name}</div>
                      {isToday(e.created_at) && <div className="employees-badge-new">오늘 가입</div>}
                    </td>
                    <td>
                      <span className={unassigned ? "employees-dept-danger" : ""}>{deptLabel(e.department_id)}</span>
                    </td>
                    <td>
                      <span className="employees-role-tag">{ROLE_LABEL[e.role]}</span>
                    </td>
                    <td className="employees-email">{e.email}</td>
                    <td>
                      <StatusDot ok={!!e.kakaowork_user_id} label={e.kakaowork_user_id ? "연결됨" : "미연결"} />
                    </td>
                    <td className="employees-actions">
                      <div className="employees-actions-inner">
                      {!isAdmin ? null : unassigned ? (
                        assigningId === e.id ? (
                          <select
                            autoFocus
                            className="employees-assign-select"
                            defaultValue=""
                            onChange={(ev) => assignDept(e.id, ev.target.value)}
                            onBlur={() => setAssigningId(null)}
                          >
                            <option value="" disabled>
                              부서 선택
                            </option>
                            {deptOptions.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <button
                            type="button"
                            className="employees-assign-btn"
                            onClick={() => setAssigningId(e.id)}
                          >
                            부서 지정
                          </button>
                        )
                      ) : (
                        <>
                          <button
                            type="button"
                            className="employees-icon-btn"
                            aria-label={`${e.name} 수정`}
                            onClick={() => openEdit(e)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                              <path
                                d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="employees-icon-btn"
                            aria-label={`${e.name} 삭제`}
                            onClick={() => deleteEmployee(e)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                              <path
                                d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        </>
                      )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="employees-empty">
                    조건에 맞는 직원이 없습니다
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="employees-footnote">
            카카오워크 미연결 직원은 메시지를 받을 수 없습니다 · 삭제 시 지침 수신자 지정에서도 제외됩니다
          </p>
        </div>
      )}

      {formOpen && (
        <Modal
          title={form.id ? "직원 수정" : "직원 추가"}
          desc={form.id ? undefined : "사전 등록용입니다 · 가입 시 이메일이 일치하면 자동으로 병합됩니다"}
          onClose={() => setFormOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setFormOpen(false)}>
                취소
              </Button>
              <Button variant="primary" onClick={submitForm} disabled={saving}>
                {saving ? "저장 중…" : "저장"}
              </Button>
            </>
          }
        >
          <div className="employees-form">
            <label className="employees-form-field">
              <span>이름</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="employees-form-field">
              <span>이메일</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </label>
            <label className="employees-form-field">
              <span>부서</span>
              <select
                value={form.department_id ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, department_id: e.target.value || null }))}
              >
                <option value="">미지정</option>
                {deptOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="employees-form-field">
              <span>역할</span>
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as EmpRole }))}
              >
                {ROLE_ORDER.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Modal>
      )}

      {deptModalOpen && (
        <DeptModal
          onClose={closeDeptModal}
          onChanged={() => {
            loadAll();
          }}
        />
      )}

      {toast && (
        <div className={`employees-toast employees-toast-${toast.kind}`} role="status">
          {toast.message}
        </div>
      )}
    </AppLayout>
  );
}
