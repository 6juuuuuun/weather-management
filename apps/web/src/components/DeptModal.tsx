import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { ApiError } from "../lib/api/client";
import { listDepartments, createDepartment, renameDepartment, deleteDepartment } from "../lib/api/org";
import type { DepartmentRow } from "../lib/api/org";
import "./DeptModal.css";

type EditingState = { id: string; name: string } | null;

// 서버(org.ts)는 departments를 id/name만 평면으로 내려주고(parent_id/sort_order 없음),
// insert/update도 name만 받는다 — 상위/하위 부서 계층은 이 API로 다룰 수 없다.
// 그래서 이 모달은 예전의 2단 트리(최상위 + 하위) 대신 평면 목록만 보여준다.
// task-8-report.md에 이 제약을 자세히 적어 뒀다.
export function DeptModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditingState>(null);
  const [addingTop, setAddingTop] = useState(false);
  const [newTopName, setNewTopName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const rows = await listDepartments();
      setDepartments(rows);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "부서 목록을 불러오지 못했습니다");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function notifyChanged() {
    await load();
    onChanged?.();
  }

  async function renameDept(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setEditing(null);
      return;
    }
    try {
      await renameDepartment(id, trimmed);
      setEditing(null);
      await notifyChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "이름 변경에 실패했습니다");
    }
  }

  async function addTopLevel(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setAddingTop(false);
      setNewTopName("");
      return;
    }
    try {
      await createDepartment(trimmed);
      setAddingTop(false);
      setNewTopName("");
      await notifyChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "부서 추가에 실패했습니다");
    }
  }

  async function deleteDept(dept: DepartmentRow) {
    const ok = window.confirm(
      `'${dept.name}' 부서를 삭제하시겠습니까?\n소속 직원은 미지정으로 이동합니다. 이 부서로 등록된 수신자 지정은 함께 삭제됩니다.`,
    );
    if (!ok) return;

    setError(null);
    try {
      await deleteDepartment(dept.id);
      await notifyChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "부서 삭제에 실패했습니다");
    }
  }

  return (
    <Modal
      title="부서 관리"
      desc="부서 삭제 시 소속 직원은 '미지정'으로 이동합니다"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            닫기
          </Button>
          <Button variant="primary" onClick={onClose}>
            저장
          </Button>
        </>
      }
    >
      {error && <p className="dept-modal-error">{error}</p>}
      {loading ? (
        <p className="dept-modal-loading">불러오는 중…</p>
      ) : (
        <div className="dept-modal-tree">
          <div className="dept-modal-group">
            {departments.map((dept) => (
              <DeptRow
                key={dept.id}
                dept={dept}
                editing={editing}
                onStartEdit={() => setEditing({ id: dept.id, name: dept.name })}
                onEditChange={(name) => setEditing((e) => (e ? { ...e, name } : e))}
                onCommitEdit={() => editing && renameDept(editing.id, editing.name)}
                onCancelEdit={() => setEditing(null)}
                onDelete={() => deleteDept(dept)}
              />
            ))}
          </div>

          {addingTop ? (
            <div className="dept-modal-row">
              <span className="dept-modal-grip" aria-hidden="true">
                ::
              </span>
              <input
                autoFocus
                className="dept-modal-input"
                placeholder="새 부서 이름"
                value={newTopName}
                onChange={(e) => setNewTopName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTopLevel(newTopName);
                  if (e.key === "Escape") {
                    setAddingTop(false);
                    setNewTopName("");
                  }
                }}
                onBlur={() => addTopLevel(newTopName)}
              />
            </div>
          ) : (
            <button type="button" className="dept-modal-add-top" onClick={() => setAddingTop(true)}>
              + 부서 추가
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

function DeptRow({
  dept,
  editing,
  onStartEdit,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
  onDelete,
}: {
  dept: DepartmentRow;
  editing: EditingState;
  onStartEdit: () => void;
  onEditChange: (name: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  const isEditing = editing?.id === dept.id;
  return (
    <div className="dept-modal-row">
      <span className="dept-modal-grip" aria-hidden="true">
        ::
      </span>
      {isEditing ? (
        <input
          autoFocus
          className="dept-modal-input"
          value={editing.name}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitEdit();
            if (e.key === "Escape") onCancelEdit();
          }}
          onBlur={onCommitEdit}
        />
      ) : (
        <span className="dept-modal-name">{dept.name}</span>
      )}
      <span className="dept-modal-row-actions">
        <button type="button" className="dept-modal-icon-btn" aria-label={`${dept.name} 이름 수정`} onClick={onStartEdit}>
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path
              d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button type="button" className="dept-modal-icon-btn" aria-label={`${dept.name} 삭제`} onClick={onDelete}>
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path
              d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </span>
    </div>
  );
}
