import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AppLayout } from "../components/AppLayout";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { useAuth } from "../auth/AuthProvider";
import { criteria as fetchCriteria, saveCriteria } from "../lib/api/dashboard";
import type { CriteriaRow } from "../lib/api/dashboard";
import { listDepartments, listEmployees, alertRecipients, saveAlertRecipients } from "../lib/api/org";
import type { DepartmentRow } from "../lib/api/org";
import { flattenDepartments, deptPathLabel } from "../lib/deptTree";
import { ApiError } from "../lib/api/client";
import type { EmpRole, Grade, Kind } from "../lib/types";
import { ROLE_LABEL } from "../lib/roles";
import "./Criteria.css";

// Task 2 시드(supabase/seed.sql)와 동일한 값 — 프리셋 불러오기 시 이 값으로 로컬 state를 리셋한다.
const PRESET: Record<Kind, Record<Grade, Record<string, number>>> = {
  rain: { watch: { rain_mm_per_hr: 20 }, warning: { rain_mm_per_hr: 50 } },
  snow: { watch: { snow_cm: 5 }, warning: { snow_cm: 20 } },
  wind: { watch: { wind_ms: 14 }, warning: { wind_ms: 21 } },
  heat: {
    watch: { temp_c: 33, feels_c: 31 },
    warning: { temp_c: 35, feels_c: 33 },
  },
};

const KIND_ORDER: Kind[] = ["rain", "snow", "wind", "heat"];
const GRADE_ORDER: Grade[] = ["watch", "warning"];

type ThresholdField = { key: string; unit: string };
type RowDef = { kind: Kind; label: string; desc: string; icon: ReactNode; fields: ThresholdField[] };

function RainIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M17 9a4 4 0 0 1-.3 8H8a3.5 3.5 0 0 1-.6-6.95A4 4 0 0 1 15 7.1 4 4 0 0 1 17 9Z"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 19.5 8 21M13 19.5l-1 1.5M17 19.5l-1 1.5" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SnowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M12 3 10 5m2-2 2 2M12 21l-2-2m2 2 2-2M4.5 7.5l2.6-.3m-2.6.3 1-2.4M19.5 7.5l-2.6-.3m2.6.3-1-2.4M4.5 16.5l2.6.3m-2.6-.3 1 2.4M19.5 16.5l-2.6.3m2.6-.3-1 2.4"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WindIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M3 8h11a2.5 2.5 0 1 0-2.2-3.7" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 12h15a2.5 2.5 0 1 1-2.2 3.7" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 16h9a2 2 0 1 1-1.8 2.9" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function HeatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M12 4a2 2 0 0 1 2 2v8.3a3.5 3.5 0 1 1-4 0V6a2 2 0 0 1 2-2Z"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 8v6.3" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const ROW_DEFS: RowDef[] = [
  { kind: "rain", label: "폭우", desc: "시간당 강수량", icon: <RainIcon />, fields: [{ key: "rain_mm_per_hr", unit: "mm 이상" }] },
  // 판정은 "이번 시간에 온 눈"이 아니라 **당일(자정 이후) 누적 신적설**을 본다
  // (server/src/shared/engine.ts의 exceeds("snow") → obs.snowToday). 화면이 "현 시간 기준"이라고
  // 적어 두면 관리자는 "한 시간에 5cm"로 읽고 값을 넣는데 실제 판정은 "오늘 통틀어 5cm"다
  // — 기준이 의도보다 훨씬 자주 걸린다(QA W-04).
  { kind: "snow", label: "폭설", desc: "오늘 누적 적설량(자정 기준)", icon: <SnowIcon />, fields: [{ key: "snow_cm", unit: "cm 이상" }] },
  { kind: "wind", label: "강풍", desc: "10분 평균 풍속", icon: <WindIcon />, fields: [{ key: "wind_ms", unit: "m/s 이상" }] },
  {
    kind: "heat",
    label: "폭염",
    // 폭염만 입력칸이 2개라 라벨 폭이 좁다. "현재"는 다른 지표 설명에도 없는 수식어이고
    // 어차피 현재 관측값을 뜻하므로 빼서 한 줄에 맞춘다(행 높이가 다른 행과 어긋나지 않게).
    desc: "기온 또는 체감온도",
    icon: <HeatIcon />,
    fields: [
      { key: "temp_c", unit: "℃ 또는 체감" },
      { key: "feels_c", unit: "℃ 이상" },
    ],
  },
];

// 값이 ""인 것은 "비어 있다"이지 0이 아니다. 예전에는 입력칸을 비우는 순간
// `value === "" ? 0 : Number(value)`가 0을 넣었고, 그 0이 그대로 저장돼
// **매시간 특보**가 떴다(QA W-10). 빈 상태를 상태로 유지하고 저장 시점에 막는다.
type ThresholdValue = number | "";
type CriteriaState = Record<Kind, Record<Grade, Record<string, ThresholdValue>>>;

function clonePreset(): CriteriaState {
  return JSON.parse(JSON.stringify(PRESET)) as CriteriaState;
}

/** 이 종류에서 엔진이 실제로 읽는 임계값 키(shared/engine.ts의 exceeds와 같다). */
function fieldKeysOf(kind: Kind): string[] {
  return ROW_DEFS.find((r) => r.kind === kind)!.fields.map((f) => f.key);
}

type RecipientEmployee = {
  id: string;
  name: string;
  role: EmpRole;
  department_id: string | null;
  /** 이 사람에게 특보를 보낼 수 있는가. 서버가 판정해 내려준다(형식 규칙은 서버에만 있다). */
  notifiable: boolean;
};

export default function Criteria() {
  const { employee } = useAuth();
  const isAdmin = employee?.role === "admin";

  const [loading, setLoading] = useState(true);
  const [criteria, setCriteria] = useState<CriteriaState>(() => clonePreset());
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [recipients, setRecipients] = useState<RecipientEmployee[]>([]);
  const [candidates, setCandidates] = useState<RecipientEmployee[]>([]);
  const [addingRecipient, setAddingRecipient] = useState(false);
  // 수신자가 어느 부서인지 그리려면 부서 목록이 필요하다(QA W-31).
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const [criteriaRows, recipientRows, candidateRows, deptRows] = await Promise.all([
          fetchCriteria(),
          // GET /api/alert-recipients는 이제 평면 형태 { employee_id, name, role }로 온다
          // (예전의 { employee_id, employees: {...} } 중첩이 아니다).
          alertRecipients(),
          // **역할로 거르지 않는다**(QA W-08b). 승인 권한은 역할이 아니라 이 목록의
          // 등록 여부에서만 나온다(스펙 2026-08-13). 후보를 admin·approver로만
          // 좁혀 두면 화면이 "역할이 권한을 정한다"고 가르치고, 실제로 승인을 맡을
          // 실무자를 여기서 고를 수조차 없다.
          listEmployees(),
          listDepartments(),
        ]);
        if (!active) return;

        const next = clonePreset();
        for (const row of criteriaRows) {
          const kind = row.kind;
          const grade = row.grade;
          // 통째로 대체하지 않고 **아는 키만** 덮어쓴다(QA W-10). 예전에는
          // `next[kind][grade] = row.threshold`라, 한 번 저장된 오타 키가 화면
          // 상태에 그대로 남아 다시 저장해도 지워지지 않았고, 빠진 키는 입력칸이
          // 빈 채로 보였다 — 그 상태로 저장하면 0이 들어갔다.
          for (const key of fieldKeysOf(kind)) {
            const v = (row.threshold as Record<string, unknown>)[key];
            next[kind][grade][key] = typeof v === "number" ? v : "";
          }
        }
        setCriteria(next);

        const toRecipient = (r: {
          id: string; name: string; role: EmpRole;
          department_id: string | null; notifiable: boolean;
        }) => ({ id: r.id, name: r.name, role: r.role,
                 department_id: r.department_id, notifiable: r.notifiable });
        setRecipients(recipientRows.map((r) => toRecipient({ ...r, id: r.employee_id })));
        setCandidates(candidateRows.map((c) => toRecipient(c)));
        setDepartments(deptRows);
      } catch (err) {
        // supabase-js는 HTTP 오류에 reject하지 않고 {data:null,error}를 돌려줬다 — 옛
        // 코드는 그래서 항상 setLoading(false)에 도달했다. 새 클라이언트는 던지므로
        // try/catch/finally 없이는 세션 만료(401) 한 번에 "불러오는 중…"이 영구히 남는다.
        if (!active) return;
        setErrorMsg(err instanceof ApiError ? err.message : "특보 기준을 불러오지 못했습니다");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function setField(kind: Kind, grade: Grade, key: string, value: string) {
    setCriteria((prev) => ({
      ...prev,
      [kind]: {
        ...prev[kind],
        [grade]: {
          ...prev[kind][grade],
          // 빈 칸은 빈 칸으로 둔다 — 0으로 바꾸면 그 0이 저장돼 매시간 특보가 뜬다.
          [key]: value === "" ? "" : Number(value),
        },
      },
    }));
  }

  // 저장 전에 화면에서 먼저 막는다. 서버도 같은 규칙으로 막지만(최종 관문),
  // 관리자가 여덟 칸을 다 채운 뒤에 한 줄짜리 400을 받는 것보다 그 자리에서
  // 무엇이 잘못됐는지 아는 편이 낫다(QA W-10).
  function validationError(): string | null {
    for (const row of ROW_DEFS) {
      for (const grade of GRADE_ORDER) {
        for (const field of row.fields) {
          const v = criteria[row.kind][grade][field.key];
          const label = `${row.label} ${grade === "watch" ? "주의보" : "경보"}`;
          if (v === "" || v === null || Number.isNaN(v)) return `${label} 기준이 비어 있습니다`;
          if (!Number.isFinite(v) || v <= 0) return `${label} 기준은 0보다 커야 합니다`;
        }
      }
      for (const field of row.fields) {
        const watch = criteria[row.kind].watch[field.key];
        const warning = criteria[row.kind].warning[field.key];
        if (typeof watch === "number" && typeof warning === "number" && warning < watch) {
          return `${row.label} 경보 기준(${warning})이 주의보 기준(${watch})보다 낮습니다 — 경보는 주의보보다 높아야 합니다`;
        }
      }
    }
    return null;
  }

  function handleLoadPreset() {
    setCriteria(clonePreset());
  }

  async function handleSave() {
    const invalid = validationError();
    if (invalid) {
      setErrorMsg(invalid);
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    const rows: CriteriaRow[] = KIND_ORDER.flatMap((kind) =>
      GRADE_ORDER.map((grade) => ({
        kind,
        grade,
        // validationError()가 이미 모든 칸이 숫자임을 확인했다.
        threshold: criteria[kind][grade] as Record<string, number>,
      })),
    );
    try {
      // PUT /api/criteria — (kind,grade) 기준 upsert. 배치 하나라도 kind/grade가
      // 잘못되면 서버가 아무것도 쓰지 않고 400을 돌려준다.
      await saveCriteria(rows);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : "저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }

  // alert_recipients는 부분 갱신이 아니라 전체 교체다(PUT /api/alert-recipients) — 화면이
  // '전체 선택 상태'를 넘긴다. 추가/삭제 모두 현재 목록에서 계산한 전체 id 목록을 보낸다.
  async function handleAddRecipient(employeeId: string) {
    if (!employeeId) return;
    setAddingRecipient(false);
    const emp = candidates.find((c) => c.id === employeeId);
    if (!emp) return;
    const nextIds = [...recipients.map((r) => r.id), employeeId];
    try {
      await saveAlertRecipients(nextIds);
      setRecipients((prev) => [...prev, emp]);
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : "저장에 실패했습니다");
    }
  }

  async function handleRemoveRecipient(employeeId: string) {
    const nextIds = recipients.filter((r) => r.id !== employeeId).map((r) => r.id);
    try {
      await saveAlertRecipients(nextIds);
      setRecipients((prev) => prev.filter((r) => r.id !== employeeId));
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : "저장에 실패했습니다");
    }
  }

  const recipientIds = new Set(recipients.map((r) => r.id));
  const addableCandidates = candidates.filter((c) => !recipientIds.has(c.id));

  // 부서 라벨은 루트부터의 전체 경로다 — 시드에도 서로 다른 부모 밑에 같은 이름이
  // 있어서(리조트 · 조리 / 골프 · 조리) 잎 이름만으로는 구분되지 않는다.
  const deptLabel = (id: string | null): string => {
    if (!id) return "부서 미지정";
    const found = flattenDepartments(departments).find((f) => f.dept.id === id);
    return found ? deptPathLabel(found.path) : "부서 미지정";
  };

  const actions = isAdmin ? (
    <>
      <Button variant="ghost" onClick={handleLoadPreset} disabled={saving}>
        기상청 특보 기준 불러오기
      </Button>
      <Button variant="primary" onClick={handleSave} disabled={saving || loading}>
        {saving ? "저장 중..." : "변경사항 저장"}
      </Button>
    </>
  ) : undefined;

  return (
    <AppLayout title="특보 기준" actions={actions}>
      {showSuccess && (
        <div className="criteria-banner criteria-banner-success" role="status">
          변경사항이 저장되었습니다
        </div>
      )}
      {errorMsg && (
        <div className="criteria-banner criteria-banner-error" role="alert">
          {errorMsg}
        </div>
      )}

      <p className="criteria-intro">
        날씨 요소별 임계값을 설정합니다. 기준 초과 시 특보가 감지되고 Alert 수신자에게 알림이 발송됩니다
      </p>

      {loading ? (
        <p className="criteria-loading">불러오는 중...</p>
      ) : (
        <div className="criteria-grid">
          {GRADE_ORDER.map((grade) => (
            <section className="criteria-card" key={grade}>
              <div className="criteria-card-header">
                <div>
                  <h2 className="criteria-card-title">{grade === "watch" ? "주의보 기준" : "경보 기준"}</h2>
                  <p className="criteria-card-desc">
                    {grade === "watch" ? "기준 초과 시 특보를 감지하고 초안을 작성합니다" : "즉시 대응이 필요한 상위 등급 기준입니다"}
                  </p>
                </div>
                <Badge grade={grade} />
              </div>

              <div className="criteria-rows">
                {ROW_DEFS.map((row) => (
                  <div className="criteria-row" key={row.kind}>
                    <div className="criteria-row-info">
                      <span className="criteria-row-icon">{row.icon}</span>
                      <div>
                        <div className="criteria-row-label">{row.label}</div>
                        <div className="criteria-row-desc">{row.desc}</div>
                      </div>
                    </div>
                    <div className="criteria-row-fields">
                      {row.fields.map((field) => (
                        <div className="criteria-field" key={field.key}>
                          {/* 시각적으로는 왼쪽 라벨("폭우 / 시간당 강수량")이 어느 기준인지 알려주지만
                              프로그램적으로는 연결돼 있지 않아, 스크린리더에는 값만 읽혔다.
                              등급·항목·단위를 합쳐 접근명을 만든다. */}
                          <input
                            type="number"
                            className="criteria-input"
                            aria-label={`${grade === "watch" ? "주의보" : "경보"} ${row.label} 기준 · ${row.desc} (${field.unit})`}
                            value={criteria[row.kind][grade][field.key] ?? ""}
                            disabled={!isAdmin}
                            onChange={(e) => setField(row.kind, grade, field.key, e.target.value)}
                          />
                          <span className="criteria-unit">{field.unit}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <section className="criteria-card criteria-recipients">
        <h2 className="criteria-card-title">특보 Alert 수신자</h2>
        {/* 이 규칙은 지금까지 화면 어디에도, 운영 안내서에도 적혀 있지 않았다(QA W-08).
            QA 엔지니어 한 명이 "실무자로 강등해도 승인 권한이 남는다"를 결함으로
            신고했다가 다른 엔지니어가 정상 동작임을 확인해 취소했다 — 전문가도
            헷갈렸다면 관리자는 반드시 헷갈린다. 규칙 자체는 옳다(스펙 2026-08-13,
            db/migrations/0007): 승인 요청을 받는 사람과 승인할 수 있는 사람은
            정의상 같아야 한다. 보이지 않는 것이 결함이었다. */}
        <p className="criteria-card-desc">
          특보 감지 시 초안 검토 요청을 받는 사람입니다. <strong>이 목록이 특보 승인 권한의
          유일한 출처입니다</strong> — 여기 있는 사람만 승인·발송할 수 있고,
          역할(관리자·승인자·실무자)은 승인 권한과 아무 관계가 없습니다.
          권한을 주거나 회수하려면 역할이 아니라 이 목록에서 넣고 빼세요.
        </p>

        <div className="criteria-chip-row">
          {recipients.map((r) => (
            <Chip
              key={r.id}
              // 이름만으로는 동명이인을 구분할 수 없고, 연락 가능 여부가 없으면
              // 번호가 없는 사람을 승인권자로 지정해 두고도 그 사실을 알 방법이
              // 없다 — 그 사람은 승인 요청 문자를 받지 못한다(QA W-31).
              label={
                `${r.name} · ${deptLabel(r.department_id)}` +
                (r.notifiable ? "" : " · 휴대폰 번호 없음")
              }
              tone={r.notifiable ? "default" : "warn"}
              onRemove={isAdmin ? () => handleRemoveRecipient(r.id) : undefined}
            />
          ))}
          {recipients.length === 0 && (
            <span className="criteria-recipients-empty">
              지정된 수신자가 없습니다 — 특보가 떠도 승인할 수 있는 사람이 아무도 없습니다
            </span>
          )}

          {isAdmin &&
            (addingRecipient ? (
              <span className="criteria-add-select-wrap">
                <select
                  className="criteria-add-select"
                  autoFocus
                  defaultValue=""
                  onChange={(e) => handleAddRecipient(e.target.value)}
                  onBlur={() => setAddingRecipient(false)}
                >
                  <option value="" disabled>
                    직원 선택
                  </option>
                  {addableCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {deptLabel(c.department_id)} · {ROLE_LABEL[c.role]}
                      {c.notifiable ? "" : " (휴대폰 번호 없음)"}
                    </option>
                  ))}
                </select>
              </span>
            ) : (
              <button type="button" className="criteria-add-btn" onClick={() => setAddingRecipient(true)}>
                + 수신자 추가
              </button>
            ))}
        </div>
      </section>
    </AppLayout>
  );
}
