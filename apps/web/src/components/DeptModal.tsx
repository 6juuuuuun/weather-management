import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { ApiError } from "../lib/api/client";
import { listDepartments, createDepartment, renameDepartment, deleteDepartment } from "../lib/api/org";
import type { DepartmentRow } from "../lib/api/org";
import "./DeptModal.css";

type EditingState = { id: string; name: string } | null;
type AddingChildState = { parentId: string; name: string } | null;

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
  const [addingChild, setAddingChild] = useState<AddingChildState>(null);
  const [addingTop, setAddingTop] = useState(false);
  const [newTopName, setNewTopName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      // 서버가 정렬을 강제하지 않으므로(org.ts: order by name) sort_order는
      // 클라이언트에서 직접 정렬한다.
      const rows = await listDepartments();
      setDepartments([...rows].sort((a, b) => a.sort_order - b.sort_order));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "부서 목록을 불러오지 못했습니다");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const topLevel = departments.filter((d) => !d.parent_id);
  function childrenOf(id: string) {
    return departments.filter((d) => d.parent_id === id);
  }

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
    const maxSort = topLevel.reduce((m, d) => Math.max(m, d.sort_order), -1);
    try {
      await createDepartment(trimmed, { parentId: null, sortOrder: maxSort + 1 });
      setAddingTop(false);
      setNewTopName("");
      await notifyChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "부서 추가에 실패했습니다");
    }
  }

  async function addChild(parentId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setAddingChild(null);
      return;
    }
    const siblings = childrenOf(parentId);
    const maxSort = siblings.reduce((m, d) => Math.max(m, d.sort_order), -1);
    try {
      await createDepartment(trimmed, { parentId, sortOrder: maxSort + 1 });
      setAddingChild(null);
      await notifyChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "하위 부서 추가에 실패했습니다");
    }
  }

  async function deleteDept(dept: DepartmentRow) {
    const children = childrenOf(dept.id);
    const msg =
      children.length > 0
        ? `'${dept.name}' 부서와 하위 부서 ${children.length}개를 삭제하시겠습니까?\n` +
          "소속 직원은 미지정으로 이동합니다. 이 부서로 등록된 수신자 지정은 함께 삭제됩니다."
        : `'${dept.name}' 부서를 삭제하시겠습니까?\n` +
          "소속 직원은 미지정으로 이동합니다. 이 부서로 등록된 수신자 지정은 함께 삭제됩니다.";
    const ok = window.confirm(msg);
    if (!ok) return;

    setError(null);
    try {
      // parent_id는 on delete restrict이므로 하위 부서를 먼저 삭제한다.
      for (const child of children) {
        await deleteDepartment(child.id);
      }
      await deleteDepartment(dept.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "부서 삭제에 실패했습니다");
    }
    await notifyChanged();
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
          {topLevel.map((dept) => (
            <div className="dept-modal-group" key={dept.id}>
              <DeptRow
                dept={dept}
                depth={0}
                editing={editing}
                onStartEdit={() => setEditing({ id: dept.id, name: dept.name })}
                onEditChange={(name) => setEditing((e) => (e ? { ...e, name } : e))}
                onCommitEdit={() => editing && renameDept(editing.id, editing.name)}
                onCancelEdit={() => setEditing(null)}
                onAddChild={() => setAddingChild({ parentId: dept.id, name: "" })}
                onDelete={() => deleteDept(dept)}
              />
              {childrenOf(dept.id).map((child) => (
                <DeptRow
                  key={child.id}
                  dept={child}
                  depth={1}
                  editing={editing}
                  onStartEdit={() => setEditing({ id: child.id, name: child.name })}
                  onEditChange={(name) => setEditing((e) => (e ? { ...e, name } : e))}
                  onCommitEdit={() => editing && renameDept(editing.id, editing.name)}
                  onCancelEdit={() => setEditing(null)}
                  onDelete={() => deleteDept(child)}
                />
              ))}
              {addingChild?.parentId === dept.id && (
                <div className="dept-modal-row dept-modal-row-depth1">
                  <span className="dept-modal-grip" aria-hidden="true">
                    ::
                  </span>
                  <input
                    autoFocus
                    className="dept-modal-input"
                    placeholder="새 하위 부서 이름"
                    value={addingChild.name}
                    onChange={(e) => setAddingChild({ parentId: dept.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addChild(dept.id, addingChild.name);
                      if (e.key === "Escape") setAddingChild(null);
                    }}
                    onBlur={() => addChild(dept.id, addingChild.name)}
                  />
                </div>
              )}
            </div>
          ))}

          {addingTop ? (
            <div className="dept-modal-row">
              <span className="dept-modal-grip" aria-hidden="true">
                ::
              </span>
              <input
                autoFocus
                className="dept-modal-input"
                placeholder="새 최상위 부서 이름"
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
              + 최상위 부서 추가
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

function DeptRow({
  dept,
  depth,
  editing,
  onStartEdit,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
  onAddChild,
  onDelete,
}: {
  dept: DepartmentRow;
  depth: 0 | 1;
  editing: EditingState;
  onStartEdit: () => void;
  onEditChange: (name: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onAddChild?: () => void;
  onDelete: () => void;
}) {
  const isEditing = editing?.id === dept.id;
  return (
    <div className={`dept-modal-row ${depth === 1 ? "dept-modal-row-depth1" : ""}`}>
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
        <span className={depth === 0 ? "dept-modal-name" : "dept-modal-name dept-modal-name-child"}>
          {dept.name}
        </span>
      )}
      <span className="dept-modal-row-actions">
        {onAddChild && (
          <button type="button" className="dept-modal-icon-btn" aria-label={`${dept.name} 하위 부서 추가`} onClick={onAddChild}>
            +
          </button>
        )}
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
