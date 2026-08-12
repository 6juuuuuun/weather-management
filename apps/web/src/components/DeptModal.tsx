import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { supabase } from "../lib/supabase";
import type { Department } from "../lib/types";
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
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditingState>(null);
  const [addingChild, setAddingChild] = useState<AddingChildState>(null);
  const [addingTop, setAddingTop] = useState(false);
  const [newTopName, setNewTopName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data, error: err } = await supabase
      .from("departments")
      .select("*")
      .order("sort_order", { ascending: true });
    if (err) {
      setError(err.message);
    } else {
      setDepartments((data as Department[] | null) ?? []);
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
    const { error: err } = await supabase.from("departments").update({ name: trimmed }).eq("id", id);
    if (err) {
      setError(err.message);
    } else {
      setEditing(null);
      await notifyChanged();
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
    const { error: err } = await supabase
      .from("departments")
      .insert({ name: trimmed, parent_id: null, sort_order: maxSort + 1 });
    if (err) {
      setError(err.message);
    } else {
      setAddingTop(false);
      setNewTopName("");
      await notifyChanged();
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
    const { error: err } = await supabase
      .from("departments")
      .insert({ name: trimmed, parent_id: parentId, sort_order: maxSort + 1 });
    if (err) {
      setError(err.message);
    } else {
      setAddingChild(null);
      await notifyChanged();
    }
  }

  async function deleteDept(dept: Department) {
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
    // parent_id는 on delete restrict이므로 하위 부서를 먼저 삭제한다.
    for (const child of children) {
      const { error: err } = await supabase.from("departments").delete().eq("id", child.id);
      if (err) {
        setError(err.message);
        await notifyChanged();
        return;
      }
    }
    const { error: err } = await supabase.from("departments").delete().eq("id", dept.id);
    if (err) {
      setError(err.message);
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
  dept: Department;
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
