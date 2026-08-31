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
import { setAccountStatus, resetPassword } from "../lib/api/auth";
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
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [unassignedOnly, setUnassignedOnly] = useState(false);

  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<EmployeeFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // 계정(auth_accounts) 상태다. GET /api/employees는 employees 컬럼만 내려주고
  // auth_accounts.status는 포함하지 않는다 — 서버가 그 값을 화면에 내려줄 방법이
  // 아직 없어서, 이 화면에서 비활성화한 계정만 세션 동안 흐리게 표시한다(새로고침하면
  // 초기화된다). accountId(=employees.auth_user_id) 기준으로 추적한다.
  const [disabledAccountIds, setDisabledAccountIds] = useState<Set<string>>(new Set());
  const [accountBusyId, setAccountBusyId] = useState<string | null>(null);
  const [tempPasswordModal, setTempPasswordModal] = useState<{ name: string; password: string } | null>(null);

  const [deptModalOpen, setDeptModalOpen] = useState(searchParams.get("dept") === "open" && isAdmin);
  const [toast, setToast] = useState<ToastState>(null);

  // 오류를 여기서 삼켜 loadError로 바꾼다 — 이 함수는 초기 로드 말고도 저장·삭제·배정
  // 직후에 불린다. 던지게 두면 그 호출부의 catch가 로드 실패를 "저장에 실패했습니다"로
  // 잘못 보고한다(저장은 이미 성공한 뒤다).
  async function loadAll() {
    setLoadError(null);
    try {
      const [emps, depts] = await Promise.all([listEmployees(), listDepartments()]);
      // employees API는 정렬 순서를 강제하지 않는다(org.ts: order by name) — 화면은
      // "최근 가입 우선"을 기대했으므로 created_at 내림차순으로 다시 정렬한다.
      setEmployees([...emps].sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setDepartments(depts);
    } catch (err) {
      // supabase-js는 HTTP 오류에 reject하지 않아 항상 setLoading(false)에 닿았다.
      // 새 클라이언트는 던지므로 catch/finally 없이는 세션 만료(401) 한 번에
      // "불러오는 중…"이 영구히 남는다.
      setLoadError(err instanceof ApiError ? err.message : "직원 목록을 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const deptById = useMemo(() => {
    const map = new Map<string, DepartmentRow>();
    for (const d of departments) map.set(d.id, d);
    return map;
  }, [departments]);

  const deptLabel = useMemo(() => {
    return (id: string | null): string => {
      if (!id) return "미지정";
      const dept = deptById.get(id);
      if (!dept) return "미지정";
      if (!dept.parent_id) return dept.name;
      const parent = deptById.get(dept.parent_id);
      return parent ? `${parent.name} · ${dept.name}` : dept.name;
    };
  }, [deptById]);

  const deptOptions = useMemo(() => {
    const top = departments.filter((d) => !d.parent_id).sort((a, b) => a.sort_order - b.sort_order);
    const options: { id: string; label: string }[] = [];
    for (const t of top) {
      options.push({ id: t.id, label: t.name });
      for (const child of departments.filter((d) => d.parent_id === t.id).sort((a, b) => a.sort_order - b.sort_order)) {
        options.push({ id: child.id, label: `${t.name} · ${child.name}` });
      }
    }
    return options;
  }, [departments]);

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
        // 이메일은 가입(POST /api/auth/signup)이 이 직원 행에 계정을 이어 붙이는
        // 병합 키다 — 보내지 않으면 관리자가 오타를 고쳤다고 믿는데 값은 버려지고,
        // 그 직원은 가입해도 부서·역할이 유실된 별도 계정이 된다. 서버가 중복 이메일에
        // 409를 주므로 아래 catch가 그 문구를 그대로 보여준다.
        await updateEmployee(form.id, {
          name: form.name.trim(),
          email: form.email.trim(),
          department_id: form.department_id,
          role: form.role,
        });
        setToast({ kind: "ok", message: "직원 정보를 수정했습니다" });
      } else {
        // 계정 없이 사전 등록만 한다 — 실제 로그인 계정은 본인이 나중에
        // /api/auth/signup으로 만들면 이메일이 일치해 자동으로 이어붙는다.
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

  // 가입은 열려 있고 권한만 관리자가 준다 — 이 역할 변경이 실제 승인 권한을 여닫는
  // 관문이다. 화면이 없으면 아무도 특보를 승인할 수 없다.
  async function changeRole(employeeId: string, role: EmpRole) {
    try {
      await updateEmployee(employeeId, { role });
      setToast({ kind: "ok", message: "역할을 변경했습니다" });
      await loadAll();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof ApiError ? err.message : "역할 변경에 실패했습니다" });
    }
  }

  // 퇴사자를 막는 유일한 수단이다. 서버가 비활성화와 동시에 남아 있는 세션도 끊는다.
  async function toggleAccountStatus(e: EmployeeRow) {
    const accountId = e.auth_user_id;
    if (!accountId) return;
    const disabling = !disabledAccountIds.has(accountId);
    const ok = window.confirm(
      disabling
        ? `${e.name} 님의 로그인 계정을 비활성화하시겠습니까?\n로그인할 수 없게 되고, 남아 있는 세션도 모두 끊깁니다.`
        : `${e.name} 님의 로그인 계정을 다시 활성화하시겠습니까?`,
    );
    if (!ok) return;
    setAccountBusyId(e.id);
    try {
      await setAccountStatus(accountId, disabling ? "disabled" : "active");
      setDisabledAccountIds((prev) => {
        const next = new Set(prev);
        if (disabling) next.add(accountId);
        else next.delete(accountId);
        return next;
      });
      setToast({ kind: "ok", message: disabling ? "계정을 비활성화했습니다" : "계정을 다시 활성화했습니다" });
    } catch (err) {
      setToast({ kind: "error", message: err instanceof ApiError ? err.message : "계정 상태 변경에 실패했습니다" });
    } finally {
      setAccountBusyId(null);
    }
  }

  // 응답의 temporary_password는 이 호출 한 번에만 내려온다 — 화면을 벗어나면 다시
  // 볼 수 없으므로 모달로 한 번 보여주고 당사자에게 전달하도록 안내한다.
  async function issueTempPassword(e: EmployeeRow) {
    const accountId = e.auth_user_id;
    if (!accountId) return;
    const ok = window.confirm(
      `${e.name} 님의 임시 비밀번호를 새로 발급하시겠습니까?\n기존 비밀번호는 더 이상 쓸 수 없고, 남아 있는 세션도 모두 끊깁니다.`,
    );
    if (!ok) return;
    setAccountBusyId(e.id);
    try {
      const { temporary_password } = await resetPassword(accountId);
      setTempPasswordModal({ name: e.name, password: temporary_password });
    } catch (err) {
      setToast({ kind: "error", message: err instanceof ApiError ? err.message : "임시 비밀번호 발급에 실패했습니다" });
    } finally {
      setAccountBusyId(null);
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
      ) : loadError ? (
        <p className="employees-error">직원 목록을 불러오지 못했습니다: {loadError}</p>
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
                <th>계정</th>
                <th aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const unassigned = e.department_id === null;
                const accountId = e.auth_user_id;
                const isSelf = accountId !== null && accountId === me?.auth_user_id;
                const disabled = accountId !== null && disabledAccountIds.has(accountId);
                return (
                  <tr key={e.id} className={disabled ? "employees-row-disabled" : undefined}>
                    <td>
                      <div className="employees-name">{e.name}</div>
                      {isToday(e.created_at) && <div className="employees-badge-new">오늘 가입</div>}
                    </td>
                    <td>
                      <span className={unassigned ? "employees-dept-danger" : ""}>{deptLabel(e.department_id)}</span>
                    </td>
                    <td>
                      {isAdmin ? (
                        <select
                          className="employees-role-select"
                          value={e.role}
                          aria-label={`${e.name} 역할`}
                          onChange={(ev) => changeRole(e.id, ev.target.value as EmpRole)}
                        >
                          {ROLE_ORDER.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="employees-role-tag">{ROLE_LABEL[e.role]}</span>
                      )}
                    </td>
                    <td className="employees-email">{e.email}</td>
                    <td>
                      <StatusDot ok={!!e.kakaowork_user_id} label={e.kakaowork_user_id ? "연결됨" : "미연결"} />
                    </td>
                    <td>
                      {!accountId ? (
                        <span className="employees-account-none">미가입</span>
                      ) : (
                        <div className="employees-account-cell">
                          <span className={disabled ? "employees-account-disabled" : "employees-account-active"}>
                            {disabled ? "비활성화됨" : "사용 중"}
                          </span>
                          {isAdmin && !isSelf && (
                            <div className="employees-account-actions">
                              <button
                                type="button"
                                className="employees-account-btn"
                                disabled={accountBusyId === e.id}
                                onClick={() => toggleAccountStatus(e)}
                              >
                                {disabled ? "활성화" : "비활성화"}
                              </button>
                              <button
                                type="button"
                                className="employees-account-btn"
                                disabled={accountBusyId === e.id}
                                onClick={() => issueTempPassword(e)}
                              >
                                임시 비밀번호 발급
                              </button>
                            </div>
                          )}
                        </div>
                      )}
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
                  <td colSpan={7} className="employees-empty">
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

      {tempPasswordModal && (
        <Modal
          title="임시 비밀번호 발급"
          desc={`${tempPasswordModal.name} 님에게 전달할 임시 비밀번호입니다`}
          onClose={() => setTempPasswordModal(null)}
          footer={
            <Button variant="primary" onClick={() => setTempPasswordModal(null)}>
              확인
            </Button>
          }
        >
          <p className="employees-temp-password">{tempPasswordModal.password}</p>
          <p className="employees-temp-password-warning">
            이 화면을 벗어나면 다시 볼 수 없습니다. 지금 안전하게 당사자에게 전달하세요.
          </p>
        </Modal>
      )}

      {toast && (
        <div className={`employees-toast employees-toast-${toast.kind}`} role="status">
          {toast.message}
        </div>
      )}
    </AppLayout>
  );
}
