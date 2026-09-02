import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { ApiError } from "../lib/api/client";
import {
  listDepartments,
  createDepartment,
  renameDepartment,
  moveDepartment,
  deleteDepartment,
} from "../lib/api/org";
import type { DepartmentRow } from "../lib/api/org";
import {
  buildDeptTree,
  flattenDepartments,
  deptPathLabel,
  deptSubtreeIds,
  deptDeleteOrder,
} from "../lib/deptTree";
import type { DeptNode } from "../lib/deptTree";
import "./DeptModal.css";

type EditingState = { id: string; name: string } | null;
type AddingChildState = { parentId: string; name: string } | null;

// 서버(server/src/api/org.ts의 MAX_DEPT_NAME)와 같은 값이어야 한다 — 화면이
// 더 관대하면 사용자는 다 입력한 뒤에야 400을 본다(QA W-30).
export const MAX_DEPT_NAME = 40;

// 들여쓰기는 6단에서 멈춘다. 그보다 깊어지면 이름 칸이 왼쪽으로 밀려 사라지는데,
// 편집기에서는 "몇 번째 단인가"보다 "누구 밑인가"가 중요하고 그건 순서로 읽힌다.
const INDENT_PX = 22;
const MAX_INDENT_DEPTH = 6;
const indentOf = (depth: number) => Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX;

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
      // 정렬·계층 계산은 deptTree.ts 한 곳에서만 한다(서버는 order by name만 준다).
      setDepartments(await listDepartments());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "부서 목록을 불러오지 못했습니다");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const tree = buildDeptTree(departments);
  const flat = flattenDepartments(departments);
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

  // 상위 부서 변경. 지우고 새로 만들면 그 부서의 지침·수신자 지정이 cascade로
  // 사라지므로, 조직 개편에는 이 경로만 안전하다(QA W-25c).
  async function moveDept(id: string, parentId: string | null) {
    setError(null);
    try {
      await moveDepartment(id, parentId);
      await notifyChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "상위 부서 변경에 실패했습니다");
    }
  }

  async function addTopLevel(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setAddingTop(false);
      setNewTopName("");
      return;
    }
    const maxSort = departments
      .filter((d) => !d.parent_id)
      .reduce((m, d) => Math.max(m, d.sort_order), -1);
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
    // 자식만이 아니라 자손 전체다. 3단 부서가 생길 수 있게 된 이상 직계 자식만
    // 지우면 손자에서 막혀 "일부만 지워진" 상태로 끝난다.
    const order = deptDeleteOrder(departments, dept.id);
    const descendants = order.length - 1;
    const msg =
      descendants > 0
        ? `'${dept.name}' 부서와 하위 부서 ${descendants}개를 삭제하시겠습니까?\n` +
          "소속 직원은 미지정으로 이동합니다. 이 부서로 등록된 수신자 지정은 함께 삭제됩니다."
        : `'${dept.name}' 부서를 삭제하시겠습니까?\n` +
          "소속 직원은 미지정으로 이동합니다. 이 부서로 등록된 수신자 지정은 함께 삭제됩니다.";
    const ok = window.confirm(msg);
    if (!ok) return;

    setError(null);
    try {
      // parent_id는 on delete restrict이므로 가장 깊은 것부터 지운다.
      for (const target of order) {
        await deleteDepartment(target.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "부서 삭제에 실패했습니다");
    }
    await notifyChanged();
  }

  function renderNodes(nodes: DeptNode<DepartmentRow>[]) {
    return nodes.map((node) => (
      <div className="dept-modal-group" key={node.dept.id}>
        <DeptRow
          dept={node.dept}
          depth={node.depth}
          allDepartments={departments}
          editing={editing}
          onStartEdit={() => setEditing({ id: node.dept.id, name: node.dept.name })}
          onEditChange={(name) => setEditing((e) => (e ? { ...e, name } : e))}
          onCommitEdit={() => editing && renameDept(editing.id, editing.name)}
          onCancelEdit={() => setEditing(null)}
          onAddChild={() => setAddingChild({ parentId: node.dept.id, name: "" })}
          onMove={(parentId) => moveDept(node.dept.id, parentId)}
          onDelete={() => deleteDept(node.dept)}
        />
        {renderNodes(node.children)}
        {addingChild?.parentId === node.dept.id && (
          <div className="dept-modal-row" style={{ paddingLeft: indentOf(node.depth + 1) }}>
            <span className="dept-modal-grip" aria-hidden="true">
              ::
            </span>
            <input
              autoFocus
              className="dept-modal-input"
              maxLength={MAX_DEPT_NAME}
              placeholder="새 하위 부서 이름"
              value={addingChild.name}
              onChange={(e) => setAddingChild({ parentId: node.dept.id, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") addChild(node.dept.id, addingChild.name);
                if (e.key === "Escape") setAddingChild(null);
              }}
              onBlur={() => addChild(node.dept.id, addingChild.name)}
            />
          </div>
        )}
      </div>
    ));
  }

  return (
    <Modal
      title="부서 관리"
      // 이 모달의 모든 변경(추가·이름 변경·상위 이동·삭제)은 그 자리에서 곧바로
      // 서버에 저장된다. 그런데도 아래에 `저장`과 `닫기`가 나란히 있었고 **둘 다
      // onClose만 불렀다**(QA W-25d) — 저장을 누른 사람은 그때 무언가 저장됐다고
      // 믿었고, 닫기를 누른 사람은 되돌려졌다고 믿었다. 둘 다 틀렸다.
      // 버튼을 하나로 줄이고, 즉시 저장된다는 사실을 설명에 적는다.
      desc="변경은 즉시 저장됩니다 · 부서 삭제 시 소속 직원은 '미지정'으로 이동합니다"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          닫기
        </Button>
      }
    >
      {error && <p className="dept-modal-error">{error}</p>}
      {loading ? (
        <p className="dept-modal-loading">불러오는 중…</p>
      ) : (
        <div className="dept-modal-tree">
          {renderNodes(tree)}

          {addingTop ? (
            <div className="dept-modal-row">
              <span className="dept-modal-grip" aria-hidden="true">
                ::
              </span>
              <input
                autoFocus
                className="dept-modal-input"
                maxLength={MAX_DEPT_NAME}
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
          {flat.length > 0 && (
            <p className="dept-modal-hint">
              상위 부서를 바꾸면 그 부서의 지침·수신자 지정은 그대로 따라갑니다. 삭제하고 다시 만들면 사라집니다.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function DeptRow({
  dept,
  depth,
  allDepartments,
  editing,
  onStartEdit,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
  onAddChild,
  onMove,
  onDelete,
}: {
  dept: DepartmentRow;
  depth: number;
  allDepartments: DepartmentRow[];
  editing: EditingState;
  onStartEdit: () => void;
  onEditChange: (name: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onAddChild: () => void;
  onMove: (parentId: string | null) => void;
  onDelete: () => void;
}) {
  const isEditing = editing?.id === dept.id;
  // 자기 자신과 자기 자손은 부모가 될 수 없다. 서버도 400으로 막지만, 고를 수
  // 없는 값을 목록에 남겨 두면 사용자는 오류를 받아 보고서야 안다.
  const blocked = deptSubtreeIds(allDepartments, dept.id);
  const parentChoices = flattenDepartments(allDepartments).filter((f) => !blocked.has(f.dept.id));

  return (
    <div className="dept-modal-row" style={{ paddingLeft: indentOf(depth) }}>
      <span className="dept-modal-grip" aria-hidden="true">
        ::
      </span>
      {isEditing ? (
        <input
          autoFocus
          className="dept-modal-input"
          maxLength={MAX_DEPT_NAME}
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
        <select
          className="dept-modal-parent-select"
          aria-label={`${dept.name} 상위 부서`}
          value={dept.parent_id ?? ""}
          onChange={(e) => onMove(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">최상위</option>
          {parentChoices.map((f) => (
            <option key={f.dept.id} value={f.dept.id}>
              {deptPathLabel(f.path)}
            </option>
          ))}
        </select>
        <button type="button" className="dept-modal-icon-btn" aria-label={`${dept.name} 하위 부서 추가`} onClick={onAddChild}>
          +
        </button>
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
