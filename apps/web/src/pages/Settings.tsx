import { useEffect, useState } from "react";
import { AppLayout } from "../components/AppLayout";
import { Toggle } from "../components/Toggle";
import { Button } from "../components/Button";
import { useAuth } from "../auth/AuthProvider";
import { siteSettings as fetchSiteSettings, saveSiteSettings, heartbeat as fetchHeartbeat } from "../lib/api/dashboard";
import type { SiteSettingsRow } from "../lib/api/dashboard";
import { alertSettings as fetchAlertSettings, saveAlertSettings } from "../lib/api/org";
import { ApiError } from "../lib/api/client";
import { callSend } from "../lib/api";
import type { AlertSetting, Kind } from "../lib/types";
import "./Settings.css";

const KIND_ORDER: Kind[] = ["rain", "snow", "wind", "heat"];

const KIND_LABEL: Record<Kind, string> = {
  rain: "폭우",
  snow: "폭설",
  wind: "강풍",
  heat: "폭염",
};

const KIND_DESC: Record<Kind, string> = {
  rain: "시간당 강수량 기준",
  snow: "적설량 기준 · 동절기 권장",
  wind: "10분 평균 풍속 기준",
  heat: "기온 · 체감온도 기준",
};

// 일 누적 정책은 판정 엔진이 폭우·폭설에서만 다룬다(강풍·폭염은 누적 개념 자체가 없음).
const ACCUM_UNIT: Partial<Record<Kind, string>> = {
  rain: "mm",
  snow: "cm",
};

function kindIcon(kind: Kind) {
  switch (kind) {
    case "rain":
      return (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path
            d="M17 8a4 4 0 0 1-.3 8H8a3.5 3.5 0 0 1-.6-6.95A4 4 0 0 1 15 6.1 4 4 0 0 1 17 8Z"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M8 18.5 7 20M12 18.5 11 20M16 18.5 15 20" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "snow":
      return (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "wind":
      return (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path
            d="M3 8h11a2.5 2.5 0 1 0-2.5-2.5M3 12h14a2.5 2.5 0 1 1-2.5 2.5M3 16h9a2 2 0 1 1-2 2"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "heat":
      return (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path
            d="M12 15.5V5a2 2 0 1 0-4 0v10.5a4 4 0 1 0 4 0Z"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

type RepeatOption = {
  value: string;
  label: string;
  policy: AlertSetting["repeat_policy"];
  basis?: "temp" | "feels";
};

// "일 누적 기준 이하까지"는 폭우·폭설에만 제공한다. 엔진은 강풍·폭염의 누적을 계산하지 않으므로
// 이 옵션을 강풍·폭염에 걸면 반복이 영영 나지 않거나(강풍 지속 중 침묵) 엉뚱하게 반복된다.
function repeatOptions(kind: Kind): RepeatOption[] {
  const once: RepeatOption = { value: "once", label: "최초 1회만", policy: "once" };
  if (kind === "heat") {
    return [
      once,
      { value: "hourly_temp", label: "기온 미달될 때까지 매시간", policy: "hourly_until_below", basis: "temp" },
      { value: "hourly_feels", label: "체감온도 미달될 때까지 매시간", policy: "hourly_until_below", basis: "feels" },
    ];
  }
  if (kind === "wind") {
    return [once, { value: "hourly", label: "기준 미달될 때까지 매시간", policy: "hourly_until_below" }];
  }
  return [
    once,
    { value: "hourly", label: "기준 미달될 때까지 매시간", policy: "hourly_until_below" },
    {
      value: "accum",
      label: kind === "rain" ? "일 강수량 기준 이하까지" : "일 적설량 기준 이하까지",
      policy: "until_daily_accum_below",
    },
  ];
}

// 강풍·폭염 행에 누적 정책 값이 남아 있어도(과거 데이터) 선택지가 없어 아무것도 선택되지 않는
// 상태가 되지 않도록 매시간 옵션으로 폴백한다.
function currentOptionValue(kind: Kind, setting: AlertSetting): string {
  if (setting.repeat_policy === "once") return "once";
  if (setting.repeat_policy === "until_daily_accum_below" && (kind === "rain" || kind === "snow")) return "accum";
  if (kind === "heat") return setting.heat_repeat_basis === "feels" ? "hourly_feels" : "hourly_temp";
  return "hourly";
}

function minutesAgo(isoDate: string): string {
  const diffMin = Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000));
  if (diffMin < 1) return "방금 전";
  return `${diffMin}분 전`;
}

type ToastState = { kind: "ok" | "error"; message: string } | null;

// site_settings 실제 테이블에는 address/remind_interval_min/resolve_notice/updated_at도
// 있지만 GET /api/site-settings는 id/site_name/nx/ny만 내려준다(dashboard.ts) — 나머지
// 필드는 이 화면이 로컬로만 들고 있고, 저장 엔드포인트도 없다. task-8-report.md 참고.
type EditableSiteSettings = SiteSettingsRow & {
  address: string;
  remind_interval_min: number;
  resolve_notice: boolean;
};

// db/migrations/0001_schema.sql의 site_settings 기본값 — API가 못 내려주는 필드의
// 자리표시자로만 쓴다(실제 저장된 값과 다를 수 있다).
const SITE_DEFAULTS = { address: "경기도 광주시 도척면 도척윗로 278", remind_interval_min: 30, resolve_notice: true };

export default function Settings() {
  const { employee } = useAuth();
  const isAdmin = employee?.role === "admin";

  const [alertSettings, setAlertSettings] = useState<Record<Kind, AlertSetting> | null>(null);
  const [siteSettings, setSiteSettings] = useState<EditableSiteSettings | null>(null);
  const [weatherHeartbeat, setWeatherHeartbeat] = useState<{ name: string; last_run_at: string } | null>(null);
  const [missing24h] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      // 서버(dashboard.ts)의 /observations 조회는 항상 missing=false만 돌려준다 —
      // "최근 24시간 결측 횟수"를 셀 방법이 API에 없다(task-8-report.md 참고).
      // missing24h는 항상 0으로 둔다.
      const [alertRows, site, hb] = await Promise.all([
        fetchAlertSettings(),
        fetchSiteSettings(),
        fetchHeartbeat("weather-tick"),
      ]);
      if (!active) return;
      const map = {} as Record<Kind, AlertSetting>;
      for (const row of alertRows) map[row.kind] = row;
      setAlertSettings(map);
      setSiteSettings(site ? { ...site, ...SITE_DEFAULTS } : null);
      setWeatherHeartbeat(hb);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function updateAlert(kind: Kind, patch: Partial<AlertSetting>) {
    setAlertSettings((prev) => {
      if (!prev) return prev;
      return { ...prev, [kind]: { ...prev[kind], ...patch } };
    });
  }

  function updateSite(patch: Partial<EditableSiteSettings>) {
    setSiteSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function handleSave() {
    if (!alertSettings || !siteSettings) return;
    setSaving(true);
    try {
      // PUT /api/alert-settings는 kind별 update를 서버가 한 번에 처리한다(org.ts) —
      // alert_settings는 시드로 4행이 항상 존재하고 RLS가 admin에게 update만 허용한다.
      await saveAlertSettings(
        KIND_ORDER.map((kind) => {
          const s = alertSettings[kind];
          return {
            kind,
            enabled: s.enabled,
            repeat_policy: s.repeat_policy,
            repeat_accum_threshold: s.repeat_accum_threshold,
            heat_repeat_basis: s.heat_repeat_basis,
          };
        }),
      );
      // 서버(dashboard.ts)에는 아직 site_settings 저장 엔드포인트가 없다 — 이 호출은
      // 그 엔드포인트가 생기기 전까지 404로 실패한다. task-8-report.md 참고.
      await saveSiteSettings({
        address: siteSettings.address,
        nx: siteSettings.nx,
        ny: siteSettings.ny,
        remind_interval_min: siteSettings.remind_interval_min,
        resolve_notice: siteSettings.resolve_notice,
      });
      setToast({ kind: "ok", message: "변경사항이 저장되었습니다" });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "알 수 없는 오류";
      setToast({ kind: "error", message: `저장 실패: ${message}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest() {
    setSendingTest(true);
    try {
      const result = await callSend({ mode: "test" });
      if (result.ok) {
        setToast({ kind: "ok", message: "테스트 메시지를 발송했습니다" });
      } else {
        setToast({ kind: "error", message: result.error ?? "테스트 발송에 실패했습니다" });
      }
    } catch (err) {
      setToast({ kind: "error", message: `테스트 발송 실패: ${(err as Error).message ?? "알 수 없는 오류"}` });
    } finally {
      setSendingTest(false);
    }
  }

  if (loading || !alertSettings || !siteSettings) {
    return (
      <AppLayout title="알림 설정">
        <p className="settings-loading">불러오는 중…</p>
      </AppLayout>
    );
  }

  return (
    <AppLayout
      title="알림 설정"
      actions={
        isAdmin ? (
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? "저장 중…" : "변경사항 저장"}
          </Button>
        ) : undefined
      }
    >
      <p className="settings-intro">
        특보별 알림 활성화와 반복 발송 정책, 관측 지점을 관리합니다 · {isAdmin ? "시스템 관리자 전용" : "읽기 전용"}
      </p>

      <div className="settings-grid">
        <div className="settings-col">
          <section className="settings-card">
            <h2 className="settings-card-title">특보 알림 활성화</h2>
            <p className="settings-card-desc">끄면 해당 특보는 감지 자체를 건너뜁니다</p>
            <div className="settings-alert-list">
              {KIND_ORDER.map((kind) => {
                const setting = alertSettings[kind];
                return (
                  <div className="settings-alert-row" key={kind}>
                    <span className="settings-alert-icon">{kindIcon(kind)}</span>
                    <div className="settings-alert-text">
                      <div className="settings-alert-name">{KIND_LABEL[kind]}</div>
                      <div className="settings-alert-sub">{KIND_DESC[kind]}</div>
                    </div>
                    <Toggle
                      checked={setting.enabled}
                      onChange={(checked) => updateAlert(kind, { enabled: checked })}
                      label={`${KIND_LABEL[kind]} 알림 활성화`}
                      disabled={!isAdmin}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="settings-card">
            <h2 className="settings-card-title">반복 알림 정책</h2>
            <p className="settings-card-desc">
              최초 발송은 Alert 수신자 승인이 필요하며, 반복 발송은 승인 없이 자동으로 이뤄집니다
            </p>
            <div className="settings-repeat-list">
              {KIND_ORDER.map((kind) => {
                const setting = alertSettings[kind];
                const options = repeatOptions(kind);
                const currentValue = currentOptionValue(kind, setting);
                return (
                  <div className="settings-repeat-row" key={kind}>
                    <div className="settings-repeat-kind">{KIND_LABEL[kind]}</div>
                    <div className="settings-repeat-options">
                      {options.map((opt) => {
                        const selected = currentValue === opt.value;
                        return (
                          <label
                            key={opt.value}
                            className={`settings-radio-pill ${selected ? "settings-radio-pill-selected" : ""}`}
                          >
                            <input
                              type="radio"
                              name={`repeat-${kind}`}
                              checked={selected}
                              disabled={!isAdmin}
                              onChange={() =>
                                updateAlert(kind, {
                                  repeat_policy: opt.policy,
                                  heat_repeat_basis: opt.basis ?? (kind === "heat" ? setting.heat_repeat_basis : null),
                                })
                              }
                            />
                            <span className="settings-radio-dot" aria-hidden="true" />
                            {opt.label}
                            {opt.value === "accum" && selected && (
                              <span className="settings-accum-input">
                                <input
                                  type="number"
                                  min={0}
                                  value={setting.repeat_accum_threshold ?? ""}
                                  disabled={!isAdmin}
                                  onChange={(e) =>
                                    updateAlert(kind, {
                                      repeat_accum_threshold: e.target.value === "" ? null : Number(e.target.value),
                                    })
                                  }
                                />
                                {ACCUM_UNIT[kind]}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <div className="settings-col">
          <section className="settings-card">
            <h2 className="settings-card-title">관측 지점</h2>
            <p className="settings-card-desc">기상청 초단기실황 조회에 사용할 지점입니다</p>
            <label className="settings-field">
              <span className="settings-field-label">지점 주소</span>
              <span className="settings-input-with-icon">
                <input
                  type="text"
                  value={siteSettings.address}
                  disabled={!isAdmin}
                  onChange={(e) => updateSite({ address: e.target.value })}
                />
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <circle cx="11" cy="11" r="6.5" strokeWidth="1.5" />
                  <path d="m20 20-4.3-4.3" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
            </label>
            <div className="settings-field-row">
              <label className="settings-field">
                <span className="settings-field-label">격자 X (nx)</span>
                <input
                  type="number"
                  value={siteSettings.nx}
                  disabled={!isAdmin}
                  onChange={(e) => updateSite({ nx: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field">
                <span className="settings-field-label">격자 Y (ny)</span>
                <input
                  type="number"
                  value={siteSettings.ny}
                  disabled={!isAdmin}
                  onChange={(e) => updateSite({ ny: Number(e.target.value) })}
                />
              </label>
            </div>
            <p className="settings-field-hint">격자 좌표는 주소 검색 시 자동 변환됩니다</p>
          </section>

          <section className="settings-card">
            <h2 className="settings-card-title">재알림 · 해제 알림</h2>
            <p className="settings-card-desc">초안이 승인되지 않으면 Alert 수신자에게 다시 알립니다</p>
            <div className="settings-inline-row">
              <span className="settings-field-label">재알림 간격</span>
              <span className="settings-accum-input">
                <input
                  type="number"
                  min={1}
                  value={siteSettings.remind_interval_min}
                  disabled={!isAdmin}
                  onChange={(e) => updateSite({ remind_interval_min: Number(e.target.value) })}
                />
                분마다
              </span>
            </div>
            <div className="settings-inline-row settings-inline-row-divider">
              <div>
                <div className="settings-field-label">상황 해제 알림</div>
                <div className="settings-field-hint settings-field-hint-tight">
                  특보 해제 시 발송받았던 부서에 종료 안내
                </div>
              </div>
              <Toggle
                checked={siteSettings.resolve_notice}
                onChange={(checked) => updateSite({ resolve_notice: checked })}
                label="상황 해제 알림"
                disabled={!isAdmin}
              />
            </div>
          </section>

          <section className="settings-card settings-card-dark">
            <h2 className="settings-card-title settings-card-title-dark">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M3 12h4l2 7 4-14 2 7h6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              수집 상태
            </h2>
            <div className="settings-heartbeat-row">
              <span>기상청 API</span>
              {/* GET /api/heartbeats/:name은 name/last_run_at만 내려준다(ok/note 없음) —
                  행이 있으면 "정상"으로 본다. 실제 성공/실패 여부는 이 API로 구분할 수 없다
                  (task-8-report.md 참고). */}
              <span className={`settings-heartbeat-value ${weatherHeartbeat ? "ok" : "fail"}`}>
                <span className="settings-heartbeat-dot" aria-hidden="true" />
                {weatherHeartbeat ? "정상" : "정보 없음"}
                {weatherHeartbeat && ` · 마지막 수집 ${minutesAgo(weatherHeartbeat.last_run_at)}`}
              </span>
            </div>
            <div className="settings-heartbeat-row">
              <span>카카오워크 봇</span>
              <span className="settings-heartbeat-value ok">
                <span className="settings-heartbeat-dot" aria-hidden="true" />
                연결됨 · 봇 이름 날씨경영
              </span>
            </div>
            <div className="settings-heartbeat-row">
              <span>수집 결측</span>
              <span className={`settings-heartbeat-value ${missing24h > 0 ? "warn" : "ok"}`}>
                <span className="settings-heartbeat-dot" aria-hidden="true" />
                최근 24시간 {missing24h}회
              </span>
            </div>
            {isAdmin && (
              <button
                type="button"
                className="settings-test-btn"
                onClick={handleSendTest}
                disabled={sendingTest}
              >
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M4 12 20 4 13 20l-2-7-7-1Z" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {sendingTest ? "발송 중…" : "나에게 테스트 메시지 보내기"}
              </button>
            )}
          </section>
        </div>
      </div>

      {toast && (
        <div className={`settings-toast settings-toast-${toast.kind}`} role="status">
          {toast.message}
        </div>
      )}
    </AppLayout>
  );
}
