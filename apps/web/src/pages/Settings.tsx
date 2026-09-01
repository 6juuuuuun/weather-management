import { useEffect, useState } from "react";
import { AppLayout } from "../components/AppLayout";
import { Toggle } from "../components/Toggle";
import { Button } from "../components/Button";
import { useAuth } from "../auth/AuthProvider";
import { siteSettings as fetchSiteSettings, saveSiteSettings, heartbeat as fetchHeartbeat } from "../lib/api/dashboard";
import type { HeartbeatRow, SiteSettingsRow } from "../lib/api/dashboard";
import {
  alertSettings as fetchAlertSettings,
  saveAlertSettings,
  alertRecipients as fetchAlertRecipients,
} from "../lib/api/org";
import { ApiError } from "../lib/api/client";
import { callSend } from "../lib/api/send";
import type { AlertRecipientRow } from "../lib/api/org";
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

export default function Settings() {
  const { employee } = useAuth();
  const isAdmin = employee?.role === "admin";

  const [alertSettings, setAlertSettings] = useState<Record<Kind, AlertSetting> | null>(null);
  const [siteSettings, setSiteSettings] = useState<SiteSettingsRow | null>(null);
  const [weatherHeartbeat, setWeatherHeartbeat] = useState<HeartbeatRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  // null = 아직 모른다/조회 실패. 배열이면 그 길이와 연결 수를 그대로 쓴다.
  const [alertRecipientRows, setAlertRecipients] = useState<AlertRecipientRow[] | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoadError(null);
      try {
        const [alertRows, site, hb, recipients] = await Promise.all([
          fetchAlertSettings(),
          fetchSiteSettings(),
          fetchHeartbeat("weather-tick"),
          // 이 조회만 실패해도 화면 전체가 못 뜨면 안 된다 — 아래 카카오워크 줄이
          // "확인 안 됨"으로 내려가는 것으로 충분하다.
          fetchAlertRecipients().catch(() => null),
        ]);
        if (!active) return;
        setAlertRecipients(recipients);
        const map = {} as Record<Kind, AlertSetting>;
        for (const row of alertRows) map[row.kind] = row;
        setAlertSettings(map);
        setSiteSettings(site);
        setWeatherHeartbeat(hb);
      } catch (err) {
        // supabase-js는 HTTP 오류에 reject하지 않아 항상 setLoading(false)에 닿았다.
        // 새 클라이언트는 던지므로 catch/finally 없이는 세션 만료(401) 한 번에
        // "불러오는 중…"이 영구히 남는다.
        if (!active) return;
        setLoadError(err instanceof ApiError ? err.message : "알림 설정을 불러오지 못했습니다");
      } finally {
        if (active) setLoading(false);
      }
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

  function updateSite(patch: Partial<SiteSettingsRow>) {
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
      // PATCH /api/site-settings — update만 가능하다(insert 정책 없음). 화면이
      // 편집하는 5개 필드만 보낸다.
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

  // 로드가 실패하면 alertSettings·siteSettings가 null로 남는다 — loadError를 함께
  // 보지 않으면 이 가드가 "불러오는 중…"을 영구히 붙잡는다.
  if (loading || !alertSettings || !siteSettings) {
    return (
      <AppLayout title="알림 설정">
        {loadError ? (
          <p className="settings-error">알림 설정을 불러오지 못했습니다: {loadError}</p>
        ) : (
          <p className="settings-loading">불러오는 중…</p>
        )}
      </AppLayout>
    );
  }

  // 특보를 실제로 받을 수 있는 사람 수. 카카오워크 user id가 없는 수신자에게는
  // 발송이 "카카오워크 미연결"로 실패한다(server/src/jobs/send.ts).
  const notifiableCount = (alertRecipientRows ?? []).filter((r) => !!r.kakaowork_user_id).length;

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
              <span className={`settings-heartbeat-value ${weatherHeartbeat?.ok ? "ok" : "fail"}`}>
                <span className="settings-heartbeat-dot" aria-hidden="true" />
                {weatherHeartbeat ? (weatherHeartbeat.ok ? "정상" : "오류") : "정보 없음"}
                {weatherHeartbeat && ` · 마지막 수집 ${minutesAgo(weatherHeartbeat.last_run_at)}`}
              </span>
            </div>
            {/* 예전에는 이 자리에 "연결됨 · 봇 이름 날씨경영"이 **조건 없이 초록으로
                하드코딩**돼 있었다. 정보가 없는 것이 아니라 반대 사실을 적극적으로
                주장하는 결함이었다 — 실제로 이 시스템은 특보를 한 명에게도 전달하지
                못하는 상태에서 이 화면이 "연결됨"이라고 말하고 있었다.
                봇 키가 살아 있는지는 화면에서 확인할 방법이 없다(발송해 봐야 안다).
                대신 확인할 수 있는 것을 말한다: 특보를 받을 사람이 실제로 몇 명
                연결돼 있는가. 그 수가 0이면 특보는 아무에게도 가지 않는다. */}
            <div className="settings-heartbeat-row">
              <span>카카오워크 연결</span>
              {alertRecipientRows === null ? (
                <span className="settings-heartbeat-value unknown">
                  <span className="settings-heartbeat-dot" aria-hidden="true" />
                  확인 안 됨
                </span>
              ) : notifiableCount > 0 ? (
                <span className="settings-heartbeat-value ok">
                  <span className="settings-heartbeat-dot" aria-hidden="true" />
                  Alert 수신자 {alertRecipientRows.length}명 중 {notifiableCount}명 연결됨
                </span>
              ) : (
                <span className="settings-heartbeat-value fail">
                  <span className="settings-heartbeat-dot" aria-hidden="true" />
                  {alertRecipientRows.length === 0
                    ? "Alert 수신자가 없습니다 · 특보가 전달되지 않습니다"
                    : "연결된 수신자 0명 · 특보가 전달되지 않습니다"}
                </span>
              )}
            </div>
            {/* 서버(dashboard.ts)의 /observations 조회는 missing=false를 무조건 강제해
                결측 행을 받을 방법 자체가 없다 — 결측 횟수를 셀 수 없다. 예전에는
                하드코딩된 0을 초록 "정상"으로 칠했는데, 기상청 API가 밤새 실패해도
                이 화면이 "정상"이라고 적극적으로 거짓 보고하는 셈이었다. 수집 건전성을
                확인하러 들어오는 유일한 화면이므로, 모르는 것은 모른다고 말한다.
                (결측 카운트 엔드포인트 신설은 이 라운드 범위 밖이다.) */}
            <div className="settings-heartbeat-row">
              <span>수집 결측</span>
              <span className="settings-heartbeat-value unknown">
                <span className="settings-heartbeat-dot" aria-hidden="true" />
                확인 불가 · 집계 기능 준비 중
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
