// 기상청 여름철 체감온도 (Stull 습구온도 근사 기반)
function wetBulbStull(t: number, rh: number): number {
  return t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659))
    + Math.atan(t + rh) - Math.atan(rh - 1.67633)
    + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
}

export function feelsLikeC(tempC: number, humidityPct: number, windMs: number): number {
  let v: number;
  if (tempC >= 20) {
    const tw = wetBulbStull(tempC, humidityPct);
    v = -0.2442 + 0.55399 * tw + 0.45535 * tempC - 0.0022 * tw * tw + 0.00278 * tw * tempC + 3.0;
  } else {
    const vKmh = windMs * 3.6;
    v = vKmh >= 4.8
      ? 13.12 + 0.6215 * tempC - 11.37 * Math.pow(vKmh, 0.16) + 0.3965 * tempC * Math.pow(vKmh, 0.16)
      : tempC;
  }
  return Math.round(v * 10) / 10;
}

const SNOW_PTY = new Set([2, 3, 6, 7]); // 진눈깨비·눈·빗방울눈날림·눈날림

export function snowNewCm(rainMmPerHr: number|null, pty: number|null): number|null {
  if (rainMmPerHr === null) return null;
  return SNOW_PTY.has(pty ?? 0) ? rainMmPerHr : 0; // 1mm ≈ 1cm 근사 (파일럿 가정)
}
