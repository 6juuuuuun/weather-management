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
import {
  listDepartments,
  listEmployees,
  updateEmployee,
  deleteEmployee as deleteEmployeeApi,
  createEmployee,
  alertRecipients as listAlertRecipients,
  saveAlertRecipients,
} from "../lib/api/org";
import { setAccountStatus, resetPassword } from "../lib/api/auth";
import type { DepartmentRow, EmployeeRow } from "../lib/api/org";
import type { EmpRole } from "../lib/types";
import { ROLE_LABEL } from "../lib/roles";
import { flattenDepartments, deptPathLabel } from "../lib/deptTree";
import { formatPhoneInput, PHONE_MAX_LENGTH } from "../lib/phone";
import "./Employees.css";

const ROLE_ORDER: EmpRole[] = ["admin", "approver", "staff"];

type ToastState = { kind: "ok" | "error"; message: string } | null;

type EmployeeFormState = {
  id: string | null;
  name: string;
  email: string;
  department_id: string | null;
  role: EmpRole;
  // 휴대폰 번호. **이 칸이 곧 발송 주소다**(SMS 전환). 카카오워크 시절에는 이메일
  // 조회로 채우는 별도의 값이 있었고, 그 조회가 실패하는 사람을 위해 "카카오워크 ID
  // 직접 입력"이라는 칸이 하나 더 있었다(QA W-16). 유도가 사라져 그 칸도 사라졌다.
  phone: string;
  // **불러온 그대로의 값**이다. 저장할 때 "실제로 손댔는가"를 이 값으로 가른다 —
  // 아래 submitForm의 주석에 이유가 있다.
  prev_phone: string | null;
  // 저장 직후 "이 직원이 연락 불가가 됐는가"를 판정하려면 저장 전 상태를 알아야 한다.
  // 번호 문자열이 아니라 **서버의 판정**을 들고 있는다 — 형식이 깨진 옛 값은
  // 문자열로는 "있음"이지만 발송 대상은 아니다.
  prev_notifiable: boolean;
};

// 서버(server/src/api/org.ts)와 같은 상한이어야 한다 — 화면이 더 관대하면
// 사용자는 다 입력한 뒤에야 400을 본다(QA W-30).
const MAX_NAME = 40;

const EMPTY_FORM: EmployeeFormState = {
  id: null, name: "", email: "", department_id: null, role: "staff",
  phone: "", prev_phone: null, prev_notifiable: false,
};

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

  // 계정(auth_accounts) 상태는 이제 서버 진실이다 — GET /api/employees가
  // account_status를 함께 내려준다(server/src/api/org.ts의 withAccountStatus,
  // 수정 라운드 1 · 리뷰 F3). 예전에는 이 화면이 로컬 Set으로만 흉내 내서, 다른
  // 관리자가 새로고침하거나 이 관리자 자신이 새로고침해도 방금 비활성화한 계정이
  // 다시 "사용 중"으로 보였다 — 그래서 이제 로컬 상태를 두지 않고 employees 배열의
  // account_status를 그대로 읽는다.
  const [accountBusyId, setAccountBusyId] = useState<string | null>(null);
  const [tempPasswordModal, setTempPasswordModal] = useState<
    { name: string; password: string; expiresInHours: number | null } | null
  >(null);

  // Alert 수신자 목록. 두 곳에서 쓴다: 삭제 확인창이 "승인 권한자가 줄어든다"를
  // 말할 수 있게(QA W-01d — 삭제는 alert_recipients를 cascade로 지운다), 그리고
  // staff로 강등할 때 수신자에서도 뺄지 묻기 위해(사용자 결정 D-3c).
  const [alertRecipientIds, setAlertRecipientIds] = useState<string[]>([]);
  // 강등 확인창. window.confirm은 예/아니오뿐이라 "역할만 변경 / 수신자에서도 제외 /
  // 취소" 세 갈래를 물을 수 없다.
  const [demoteAsk, setDemoteAsk] = useState<{ employee: EmployeeRow; role: EmpRole } | null>(null);

  const [deptModalOpen, setDeptModalOpen] = useState(searchParams.get("dept") === "open" && isAdmin);
  const [toast, setToast] = useState<ToastState>(null);

  // 오류를 여기서 삼켜 loadError로 바꾼다 — 이 함수는 초기 로드 말고도 저장·삭제·배정
  // 직후에 불린다. 던지게 두면 그 호출부의 catch가 로드 실패를 "저장에 실패했습니다"로
  // 잘못 보고한다(저장은 이미 성공한 뒤다).
  async function loadAll() {
    setLoadError(null);
    try {
      const [emps, depts, recips] = await Promise.all([
        listEmployees(),
        listDepartments(),
        // 실패해도 화면 전체를 막지 않는다 — 이 목록은 확인창의 경고에만 쓰인다.
        listAlertRecipients().catch(() => []),
      ]);
      setAlertRecipientIds(recips.map((r) => r.employee_id));
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

  // 드롭다운 라벨은 **루트부터의 전체 경로**다. 들여쓰기가 아니라 경로를 쓰는
  // 이유: <select>는 닫혀 있을 때 고른 항목 한 줄만 보여주므로, 들여쓰기만으로는
  // 다른 부모 밑의 같은 이름(시드에도 '리조트 · 조리'와 '골프 · 조리'가 있다)이
  // 닫힌 상태에서 구분되지 않는다. 2단까지는 지금까지 보이던 글자와 똑같고,
  // 3단부터는 그대로 한 칸 더 길어진다.
  const deptOptions = useMemo(
    () => flattenDepartments(departments).map((f) => ({ id: f.dept.id, label: deptPathLabel(f.path) })),
    [departments],
  );

  const deptLabel = useMemo(() => {
    const labels = new Map(deptOptions.map((o) => [o.id, o.label]));
    return (id: string | null): string => (id ? (labels.get(id) ?? "미지정") : "미지정");
  }, [deptOptions]);

  // 자기 행인지, 그리고 관리자가 몇 명인지 — 마지막 관리자가 스스로 내려오는 것을
  // 화면에서도 막기 위해 쓴다(QA W-19).
  const isSelf = (e: EmployeeRow) => e.auth_user_id !== null && e.auth_user_id === me?.auth_user_id;
  const adminCount = useMemo(() => employees.filter((e) => e.role === "admin").length, [employees]);

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
    setForm({
      id: e.id, name: e.name, email: e.email, department_id: e.department_id, role: e.role,
      // 이미 저장된 값은 **그대로** 보여준다. 서식을 다시 입히면 옛 규칙으로
      // 저장된 번호(유선·내선 등)가 화면에서 말없이 뭉개진다.
      phone: e.phone ?? "",
      prev_phone: e.phone,
      prev_notifiable: e.notifiable,
    });
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
        // 전화번호는 **바뀌었을 때만** 보낸다. 서버는 이제 형식을 검사하는데
        // (server/src/phone.ts) DB에는 그 규칙 이전에 들어온 값이 그대로 남아 있다 —
        // 늘 함께 보내면, 옛 번호를 가진 직원의 역할만 바꾸려던 관리자가 자기가
        // 건드리지도 않은 칸 때문에 400을 받고 그 사람의 번호를 "고쳐야" 저장할 수
        // 있게 된다. 손댄 값만 검사받는다.
        const patch: Parameters<typeof updateEmployee>[1] = {
          name: form.name.trim(),
          email: form.email.trim(),
          department_id: form.department_id,
          role: form.role,
        };
        if (form.phone.trim() !== (form.prev_phone ?? "")) {
          patch.phone = form.phone.trim() || null;
        }
        const saved = await updateEmployee(form.id, patch);
        // 연락 가능하던 사람이 저장 뒤 불가가 됐으면 그 사실을 말해 준다. 예전에는
        // 점만 초록에서 회색으로 바뀌고 아무 경고도 없었다 — 그 직원은 그날부터
        // 특보를 못 받는다. **카카오워크 연결이 끊기던 자리를 그대로 물려받는다.**
        //
        // 번호 문자열이 아니라 서버가 내린 `notifiable`을 견준다: 관리자가 번호를
        // 지운 경우뿐 아니라, 형식이 맞지 않는 값으로 바꾼 경우까지 같은 사실
        // ("이 사람에게는 이제 안 간다")로 잡힌다.
        if (form.prev_notifiable && !saved.notifiable) {
          setToast({
            kind: "error",
            message: "저장했지만 이 직원은 이제 특보 문자를 받지 못합니다 — 휴대폰 번호를 확인해 주세요",
          });
        } else {
          setToast({ kind: "ok", message: "직원 정보를 수정했습니다" });
        }
      } else {
        // 계정 없이 사전 등록만 한다 — 실제 로그인 계정은 본인이 나중에
        // /api/auth/signup으로 만들면 이메일이 일치해 자동으로 이어붙는다.
        await createEmployee({
          name: form.name.trim(),
          email: form.email.trim(),
          department_id: form.department_id,
          role: form.role,
          phone: form.phone.trim() || null,
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

  // 확인창이 실제로 벌어지는 일을 전부 말해야 한다(QA W-01d·e). 예전 문구는
  // "지침 수신자 지정에서도 함께 제외됩니다" 한 줄이라 **로그인 계정 이야기도,
  // 특보 승인 권한이 줄어든다는 이야기도** 하지 않았다. 지금은 삭제가 계정까지
  // 지우므로(되돌릴 수 없다) 더더욱 말해야 한다.
  async function deleteEmployee(e: EmployeeRow) {
    const lines = [`${e.name} 님을 삭제하시겠습니까?`, ""];
    if (e.auth_user_id) {
      lines.push("· 로그인 계정도 함께 삭제됩니다(되돌릴 수 없습니다).");
    }
    lines.push("· 지침 수신자 지정에서도 함께 제외됩니다.");
    if (alertRecipientIds.includes(e.id)) {
      lines.push("· 이 사람은 특보 승인권자입니다 — 승인할 수 있는 사람이 한 명 줄어듭니다.");
    }
    lines.push("· 지금까지의 승인·수정 이력에는 이름이 그대로 남습니다.");
    const ok = window.confirm(lines.join("\n"));
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

  // 가입은 열려 있고 권한만 관리자가 준다.
  //
  // **역할은 특보 승인 권한과 무관하다**(스펙 2026-08-13,
  // db/migrations/0007_approver_from_alert_recipients.sql). 승인 권한은 오직
  // Alert 수신자 등록 여부에서 나온다 — 여기서 approver로 올려도 승인권자가 되지
  // 않고, staff로 내려도 승인 권한은 그대로 남는다. 이 주석은 2026-08-13 이전의
  // 옛 규칙("이 역할 변경이 승인 권한을 여닫는 관문이다")을 그대로 말하고 있었고,
  // QA 엔지니어 한 명이 그 문장을 근거로 정상 동작을 결함으로 신고했다(QA W-08).
  // 역할이 정하는 것은 화면 접근 범위다(알림 설정·직원 관리 메뉴).
  //
  // 여기에 확인 절차가 하나도 없었다(QA W-19): 관리자가 자기 행의 셀렉트에서 한 칸
  // 잘못 고르면 그대로 저장됐고, 관리자가 한 명뿐인 배포에서는 그 순간 설정·직원
  // 관리·지침 등록이 전부 막혔다. 삭제·비활성화·임시 비밀번호에는 전부 확인창이 있다.
  function requestRoleChange(e: EmployeeRow, role: EmpRole) {
    if (role === e.role) return;
    // 서버도 막지만(마지막 관리자 403), 화면이 먼저 말해 주는 편이 낫다.
    if (isSelf(e) && e.role === "admin" && role !== "admin" && adminCount <= 1) {
      setToast({
        kind: "error",
        message: "마지막 관리자입니다. 다른 사람을 관리자로 지정한 뒤에 역할을 바꾸세요",
      });
      loadAll();
      return;
    }
    // staff로 내리는데 그 사람이 Alert 수신자면 수신자에서도 뺄지 묻는다
    // (사용자 결정 D-3c). 자동으로 빼지는 않는다 — 승인 권한이 역할이 아니라
    // 수신자 등록에서만 나온다는 규칙은 그대로 두고, 관리자의 의도만 확인한다.
    if (role === "staff" && alertRecipientIds.includes(e.id)) {
      setDemoteAsk({ employee: e, role });
      return;
    }
    if (!window.confirm(`${e.name} 님의 역할을 ${ROLE_LABEL[role]}(으)로 바꾸시겠습니까?`)) {
      loadAll(); // 네이티브 select가 이미 바꿔 둔 표시값을 서버 값으로 되돌린다
      return;
    }
    changeRole(e.id, role);
  }

  async function changeRole(employeeId: string, role: EmpRole, alsoRemoveRecipient = false) {
    try {
      await updateEmployee(employeeId, { role });
      if (alsoRemoveRecipient) {
        await saveAlertRecipients(alertRecipientIds.filter((id) => id !== employeeId));
      }
      setToast({
        kind: "ok",
        message: alsoRemoveRecipient ? "역할을 변경하고 특보 수신자에서 제외했습니다" : "역할을 변경했습니다",
      });
      await loadAll();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof ApiError ? err.message : "역할 변경에 실패했습니다" });
      // 리뷰 F7: <select value={e.role}>은 React 상태로 통제되지만, 네이티브 select는
      // 사용자가 고른 순간 스스로 표시값을 먼저 바꾼다. 실패 후 아무 setState도 없으면
      // 이 행이 다시 렌더되지 않아 React가 그 값을 되돌릴 기회가 없다 — 관리자는
      // 화면에 남은 "승인자"를 보고 실제로 권한이 올라간 줄 알게 된다. 성공 때와
      // 마찬가지로 서버 값을 다시 읽어와 강제로 되돌린다.
      await loadAll();
    }
  }

  // 퇴사자를 막는 유일한 수단이다. 서버가 비활성화와 동시에 남아 있는 세션도 끊는다.
  // 성공 뒤 loadAll()로 다시 불러와 화면 값이 항상 서버 진실을 따르게 한다 —
  // changeRole과 같은 이유(리뷰 F7): 로컬 상태만 낙관적으로 바꾸면 실패했을 때도
  // 화면에 새 값이 남을 수 있다.
  async function toggleAccountStatus(e: EmployeeRow) {
    const accountId = e.auth_user_id;
    if (!accountId) return;
    const disabling = e.account_status !== "disabled";
    const ok = window.confirm(
      disabling
        ? `${e.name} 님의 로그인 계정을 비활성화하시겠습니까?\n로그인할 수 없게 되고, 남아 있는 세션도 모두 끊깁니다.`
        : `${e.name} 님의 로그인 계정을 다시 활성화하시겠습니까?`,
    );
    if (!ok) return;
    setAccountBusyId(e.id);
    try {
      await setAccountStatus(accountId, disabling ? "disabled" : "active");
      setToast({ kind: "ok", message: disabling ? "계정을 비활성화했습니다" : "계정을 다시 활성화했습니다" });
      await loadAll();
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
      const { temporary_password, expires_in_hours } = await resetPassword(accountId);
      setTempPasswordModal({
        name: e.name,
        password: temporary_password,
        expiresInHours: typeof expires_in_hours === "number" ? expires_in_hours : null,
      });
    } catch (err) {
      setToast({ kind: "error", message: err instanceof ApiError ? err.message : "임시 비밀번호 발급에 실패했습니다" });
    } finally {
      setAccountBusyId(null);
    }
  }

  // 강등 확인창의 세 갈래. 취소·닫기는 서버 값을 다시 읽어 네이티브 select가
  // 이미 바꿔 둔 표시값을 되돌린다(리뷰 F7과 같은 이유).
  function cancelDemote() {
    setDemoteAsk(null);
    loadAll();
  }

  function confirmDemote(alsoRemoveRecipient: boolean) {
    const ask = demoteAsk;
    setDemoteAsk(null);
    if (ask) changeRole(ask.employee.id, ask.role, alsoRemoveRecipient);
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
                <th>휴대폰</th>
                <th>계정</th>
                <th aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const unassigned = e.department_id === null;
                const accountId = e.auth_user_id;
                const self = isSelf(e);
                const disabled = e.account_status === "disabled";
                const locked = e.account_locked === true;
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
                          onChange={(ev) => requestRoleChange(e, ev.target.value as EmpRole)}
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
                      {/* 번호 문자열이 아니라 서버의 판정(notifiable)으로 그린다 —
                          형식이 깨진 옛 값은 칸에 보이지만 발송 대상은 아니다.
                          "있음"이라고 그려 놓고 실제로는 안 가는 것이 이 프로젝트가
                          네 번 고친 상태의 모양이다. */}
                      <StatusDot ok={e.notifiable} label={e.notifiable ? "있음" : "없음"} />
                    </td>
                    <td>
                      {!accountId ? (
                        <span className="employees-account-none">미가입</span>
                      ) : (
                        <div className="employees-account-cell">
                          <span className={disabled || locked ? "employees-account-disabled" : "employees-account-active"}>
                            {disabled ? "비활성화됨" : locked ? "잠김" : "사용 중"}
                          </span>
                          {/* 잠금은 지금까지 화면에 없었고, 이 셀은 잠긴 계정도
                              "사용 중"이라고 말했다(QA W-17). 누적 횟수를 함께 보여야
                              반복 잠금(= 누가 겨냥하고 있다)을 알아볼 수 있다. */}
                          {(e.account_lock_count ?? 0) > 0 && (
                            <span className="employees-account-lockinfo">
                              잠금 누적 {e.account_lock_count}회{locked ? " · 지금 잠김" : ""}
                            </span>
                          )}
                          {isAdmin && !self && (
                            <div className="employees-account-actions">
                              <button
                                type="button"
                                className="employees-account-btn"
                                disabled={accountBusyId === e.id}
                                onClick={() => toggleAccountStatus(e)}
                              >
                                {disabled ? "활성화" : "비활성화"}
                              </button>
                              {/* 비활성 계정에는 발급하지 않는다(QA W-27) — 서버도
                                  409로 거부한다. 버튼을 그대로 두면 관리자는 발급에
                                  성공했다고 믿고 쓸 수 없는 값을 전달한다. */}
                              {!disabled && (
                                <button
                                  type="button"
                                  className="employees-account-btn"
                                  disabled={accountBusyId === e.id}
                                  onClick={() => issueTempPassword(e)}
                                >
                                  임시 비밀번호 발급
                                </button>
                              )}
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
            휴대폰 번호가 없는 직원은 특보 문자를 받을 수 없습니다 · 삭제 시 지침 수신자 지정에서도 제외됩니다
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
                maxLength={MAX_NAME}
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
            {/* 서식은 가입 화면과 같은 한 곳에서 온다(lib/phone.ts) — 숫자만 남기고
                하이픈은 화면이 넣는다. 형식 판정은 서버가 한다. */}
            <label className="employees-form-field">
              <span>휴대폰 번호</span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={PHONE_MAX_LENGTH}
                value={form.phone}
                placeholder="010-0000-0000"
                onChange={(e) => setForm((f) => ({ ...f, phone: formatPhoneInput(e.target.value) }))}
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
              {/* 관리자가 "승인권자를 늘리려면 역할을 올린다"고 학습하는 자리가
                  바로 여기다. 실제 규칙은 그렇지 않다(QA W-08). */}
              <small className="employees-form-hint">
                역할은 화면 접근 범위만 정합니다 · 특보 승인 권한은 특보 기준 화면의 Alert 수신자
                목록에서만 나옵니다
              </small>
            </label>
            {/* 카카오워크 ID 입력란은 사라졌다(SMS 전환). 그 칸이 필요했던 이유는
                발송 주소를 이메일에서 **유도**했고 그 유도가 실패하는 사람이 있었기
                때문이다 — 관리자가 손으로 메워 주는 자리였다. 이제 발송 주소를 넣는
                칸은 위의 휴대폰 번호 하나뿐이고, 유도가 없으니 메울 것도 없다. */}
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
          {tempPasswordModal.expiresInHours !== null && (
            <p className="employees-temp-password-warning">
              이 임시 비밀번호는 {tempPasswordModal.expiresInHours}시간 뒤에 만료됩니다. 그 뒤에는
              다시 발급해야 합니다.
            </p>
          )}
        </Modal>
      )}

      {demoteAsk && (
        <Modal
          title="역할 강등"
          desc={`${demoteAsk.employee.name} 님을 ${ROLE_LABEL[demoteAsk.role]}(으)로 바꿉니다`}
          onClose={cancelDemote}
          footer={
            <>
              <Button variant="ghost" onClick={cancelDemote}>
                취소
              </Button>
              <Button variant="ghost" onClick={() => confirmDemote(false)}>
                역할만 변경
              </Button>
              <Button variant="primary" onClick={() => confirmDemote(true)}>
                수신자에서도 제외
              </Button>
            </>
          }
        >
          <p>
            이 사람은 지금 <strong>특보 승인권자</strong>입니다. 승인 권한은 역할이 아니라 특보 수신자
            등록에서 나오므로, 역할만 바꾸면 승인 권한은 그대로 남습니다.
          </p>
          <p>특보 수신자에서도 뺄까요?</p>
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
