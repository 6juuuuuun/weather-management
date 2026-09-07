// server/src/jobs/forecastTick.ts
// 기상청 단기예보를 받아 weather_forecasts에 쌓는다.
//
// 관측(weatherTick)과 나눠 두는 이유: 발표 주기가 다르고(관측 매시 / 예보 하루 8회),
// 실패의 뜻도 다르다. 관측이 멈추면 특보가 안 뜨고, 예보가 멈추면 사전 예고만
// 사라진다. 한 작업에 묶으면 그 차이가 heartbeat 하나에 뭉개진다.
import { withService } from "../db.ts";
import { upsertHeartbeat } from "./weatherTick.ts";
import { fetchForecast } from "../shared/forecast.ts";
import { env } from "./common.ts";

/**
 * 예보가 이만큼 낡으면 "받지 못하고 있다"로 본다.
 *
 * 발표 간격이 3시간이므로 6시간은 **2회 연속 실패** 이후다. 3시간으로 잡으면
 * 한 번의 일시적 실패마다 경고가 떠 사람이 곧 무시하기 시작한다.
 *
 * 이 상수 하나를 서버 전체가 쓴다 — `/api/forecast`의 `stale`과
 * `/api/health/deep`의 `warnings`가 두 벌로 적히면 화면은 "정상"인데
 * warnings에는 올라 있는 상태가 생긴다.
 */
export const FORECAST_STALE_HOURS = 6;

export type ForecastTickResult = { ok: boolean; saved: number; note: string | null };

export async function runForecastTick(
  deps: { now?: Date; fetchFn?: typeof fetch } = {},
): Promise<ForecastTickResult> {
  const now = deps.now ?? new Date();

  const site = await withService(async (q) => {
    const { rows } = await q.query("select nx, ny from site_settings order by id limit 1");
    return rows[0] as { nx: number; ny: number } | undefined;
  });
  if (!site) {
    const note = "관측 지점이 설정되지 않았습니다";
    await upsertHeartbeat("forecast-tick", false, note);
    return { ok: false, saved: 0, note };
  }

  let fetched: Awaited<ReturnType<typeof fetchForecast>>;
  try {
    fetched = await fetchForecast(env("KMA_API_KEY")!, site.nx, site.ny, now, deps.fetchFn);
  } catch (e) {
    // **마지막 예보를 지우지 않는다.** 낡은 값을 "낡았다"고 말하며 보여주는
    // 것이, 아무것도 없어서 화면이 비는 것보다 낫다. fetched_at이 그대로
    // 남으므로 /api/forecast의 stale과 워치독의 warnings가 이 상태를 읽는다.
    const note = `예보 수집 실패: ${String(e)}`;
    console.error(`[forecast-tick] ${note}`);
    await upsertHeartbeat("forecast-tick", false, note);
    return { ok: false, saved: 0, note };
  }

  const saved = await withService(async (q) => {
    for (const r of fetched.rows) {
      await q.query(
        `insert into weather_forecasts
           (fcst_at, temp_c, pop_pct, pty, sky, pcp_mm, sno_cm, wsd_ms, reh_pct, tmn_c, tmx_c, base_at, fetched_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         on conflict (fcst_at) do update set
           temp_c = excluded.temp_c, pop_pct = excluded.pop_pct, pty = excluded.pty,
           sky = excluded.sky, pcp_mm = excluded.pcp_mm, sno_cm = excluded.sno_cm,
           wsd_ms = excluded.wsd_ms, reh_pct = excluded.reh_pct,
           tmn_c = excluded.tmn_c, tmx_c = excluded.tmx_c,
           base_at = excluded.base_at, fetched_at = now()`,
        [r.fcstAt, r.tempC, r.popPct, r.pty, r.sky, r.pcpMm, r.snoCm, r.wsdMs, r.rehPct,
         r.tmnC, r.tmxC, fetched.baseAt],
      );
    }
    // 지난 예보는 남겨 둘 이유가 없다. 하루치만 남기는 이유는 "오늘 아침에
    // 뭐라고 했었나"를 확인할 여지를 두기 위해서다.
    await q.query("delete from weather_forecasts where fcst_at < now() - interval '1 day'");
    return fetched.rows.length;
  });

  // HTTP는 성공(resultCode "00")했지만 items가 비어 온 경우가 있다(키 만료,
  // 관측소 점검 — observation 쪽 watchdog.ts:98-101이 이미 같은 부류를 본다).
  // saved:0인데 ok:true로 남기면 이 실패가 어디에도 보이지 않는다.
  await upsertHeartbeat("forecast-tick", saved > 0, saved === 0 ? "예보 응답이 비어 있습니다" : null);
  return { ok: true, saved, note: null };
}
