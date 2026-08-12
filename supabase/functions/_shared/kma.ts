export type KmaObservation = {
  observedAt: Date; rainMmPerHr: number|null; tempC: number|null;
  windMs: number|null; humidityPct: number|null; pty: number|null;
};

const KST = 9 * 60 * 60 * 1000;

export function baseDateTime(now: Date): { baseDate: string; baseTime: string } {
  const kst = new Date(now.getTime() + KST);
  if (kst.getUTCMinutes() < 10) kst.setUTCHours(kst.getUTCHours() - 1);
  const y = kst.getUTCFullYear(), m = String(kst.getUTCMonth()+1).padStart(2,"0"),
        d = String(kst.getUTCDate()).padStart(2,"0"), h = String(kst.getUTCHours()).padStart(2,"0");
  return { baseDate: `${y}${m}${d}`, baseTime: `${h}00` };
}

function num(items: Array<{category:string; obsrValue:string}>, cat: string): number|null {
  const v = items.find(i => i.category === cat)?.obsrValue;
  return v === undefined ? null : Number(v);
}

export function parseKmaResponse(json: any): KmaObservation {
  if (json?.response?.header?.resultCode !== "00") {
    throw new Error(`KMA error: ${JSON.stringify(json?.response?.header)}`);
  }
  const items = json.response.body.items.item as Array<{category:string; obsrValue:string; baseDate?:string; baseTime?:string}>;
  const bd = items[0]?.baseDate, bt = items[0]?.baseTime ?? "0000";
  const observedAt = bd
    ? new Date(`${bd.slice(0,4)}-${bd.slice(4,6)}-${bd.slice(6,8)}T${bt.slice(0,2)}:00:00+09:00`)
    : new Date();
  return { observedAt, rainMmPerHr: num(items,"RN1"), tempC: num(items,"T1H"),
           windMs: num(items,"WSD"), humidityPct: num(items,"REH"), pty: num(items,"PTY") };
}

const BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst";

export async function fetchObservation(
  apiKey: string, nx: number, ny: number, now: Date, fetchFn: typeof fetch = fetch,
): Promise<KmaObservation> {
  const { baseDate, baseTime } = baseDateTime(now);
  const url = `${BASE}?serviceKey=${encodeURIComponent(apiKey)}&dataType=JSON&numOfRows=10&pageNo=1&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseKmaResponse(await res.json());
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
