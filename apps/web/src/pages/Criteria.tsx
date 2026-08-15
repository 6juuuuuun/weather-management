import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AppLayout } from "../components/AppLayout";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
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
  { kind: "snow", label: "폭설", desc: "현 시간 기준 적설량", icon: <SnowIcon />, fields: [{ key: "snow_cm", unit: "cm 이상" }] },
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

type CriteriaState = Record<Kind, Record<Grade, Record<string, number>>>;

function clonePreset(): CriteriaState {
  return JSON.parse(JSON.stringify(PRESET)) as CriteriaState;
}

type RecipientEmployee = { id: string; name: string; role: EmpRole };

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

  useEffect(() => {
    let active = true;
    (async () => {
      const [criteriaRes, recipientsRes, candidatesRes] = await Promise.all([
        supabase.from("weather_criteria").select("kind,grade,threshold"),
        supabase.from("alert_recipients").select("employee_id, employees(id,name,role)"),
        supabase.from("employees").select("id,name,role").in("role", ["admin", "approver"]),
      ]);
      if (!active) return;

      const next = clonePreset();
      for (const row of criteriaRes.data ?? []) {
        const kind = row.kind as Kind;
        const grade = row.grade as Grade;
        next[kind][grade] = row.threshold as Record<string, number>;
      }
      setCriteria(next);

      type RecipientRow = { employee_id: string; employees: RecipientEmployee | RecipientEmployee[] | null };
      const recipientRows = (recipientsRes.data ?? []) as unknown as RecipientRow[];
      const recipientList = recipientRows
        .map((r) => (Array.isArray(r.employees) ? r.employees[0] : r.employees))
        .filter((e): e is RecipientEmployee => e != null);
      setRecipients(recipientList);

      setCandidates((candidatesRes.data ?? []) as RecipientEmployee[]);
      setLoading(false);
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
          [key]: value === "" ? 0 : Number(value),
        },
      },
    }));
  }

  function handleLoadPreset() {
    setCriteria(clonePreset());
  }

  async function handleSave() {
    setSaving(true);
    setErrorMsg(null);
    const rows = KIND_ORDER.flatMap((kind) =>
      GRADE_ORDER.map((grade) => ({
        kind,
        grade,
        threshold: criteria[kind][grade],
      })),
    );
    const { error } = await supabase.from("weather_criteria").upsert(rows, { onConflict: "kind,grade" });
    setSaving(false);
    if (error) {
      setErrorMsg(error.message);
      return;
    }
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  }

  async function handleAddRecipient(employeeId: string) {
    if (!employeeId) return;
    const { error } = await supabase.from("alert_recipients").insert({ employee_id: employeeId });
    setAddingRecipient(false);
    if (error) {
      setErrorMsg(error.message);
      return;
    }
    const emp = candidates.find((c) => c.id === employeeId);
    if (emp) setRecipients((prev) => [...prev, emp]);
  }

  async function handleRemoveRecipient(employeeId: string) {
    const { error } = await supabase.from("alert_recipients").delete().eq("employee_id", employeeId);
    if (error) {
      setErrorMsg(error.message);
      return;
    }
    setRecipients((prev) => prev.filter((r) => r.id !== employeeId));
  }

  const recipientIds = new Set(recipients.map((r) => r.id));
  const addableCandidates = candidates.filter((c) => !recipientIds.has(c.id));

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
        <p className="criteria-card-desc">특보 감지 시 초안 검토 요청을 받는 승인 권한자입니다</p>

        <div className="criteria-chip-row">
          {recipients.map((r) => (
            <Chip
              key={r.id}
              label={`${r.name} · ${ROLE_LABEL[r.role]}`}
              onRemove={isAdmin ? () => handleRemoveRecipient(r.id) : undefined}
            />
          ))}

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
                      {c.name} · {ROLE_LABEL[c.role]}
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
