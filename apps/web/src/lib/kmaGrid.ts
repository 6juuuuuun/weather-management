// 기상청 격자(nx, ny)를 사람이 확인할 수 있는 값으로 되돌린다.
//
// **왜 필요한가**(검증 §신규-2): 격자 범위 검사(nx 1~149, ny 1~253)는 "값이 형식상
// 유효한가"만 본다. 관리자가 곤지암(61, 121) 대신 제주 격자(52, 38)를 손으로 잘못
// 넣어도 저장이 되고, 그 순간부터 시스템은 **남의 동네 날씨로 특보를 판정한다.**
// 수집은 정상이고 관측 행도 매시간 쌓이므로 하트비트·워치독·health/deep이 전부
// 초록이다 — 곤지암에 눈이 20cm 와도 특보가 뜨지 않는다. 값 검증으로는 절대 잡을 수
// 없는 종류이고, 잡을 수 있는 유일한 사람은 화면을 보는 관리자다. 그래서 저장된
// 숫자 두 개가 **어디를 가리키는지** 화면이 말해 준다.
//
// 변환식은 기상청 동네예보 API 배포 자료의 Lambert Conformal Conic 역변환 그대로다
// (server/src/shared/kma.ts가 쓰는 것과 같은 격자 정의).

const RE = 6371.00877; // 지구 반경(km)
const GRID = 5.0; // 격자 간격(km)
const SLAT1 = 30.0; // 표준 위도 1
const SLAT2 = 60.0; // 표준 위도 2
const OLON = 126.0; // 기준점 경도
const OLAT = 38.0; // 기준점 위도
const XO = 43; // 기준점 X 좌표
const YO = 136; // 기준점 Y 좌표

const DEGRAD = Math.PI / 180.0;

export type LatLon = { lat: number; lon: number };

/** 격자 좌표를 위도·경도로 되돌린다. 범위 밖 값이면 null(그쪽은 이미 다른 검사가 막는다). */
export function gridToLatLon(nx: unknown, ny: unknown): LatLon | null {
  if (typeof nx !== "number" || typeof ny !== "number" || !Number.isFinite(nx) || !Number.isFinite(ny)) {
    return null;
  }
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  const xn = nx - XO;
  const yn = ro - ny + YO;
  let ra = Math.sqrt(xn * xn + yn * yn);
  if (sn < 0) ra = -ra;
  let alat = Math.pow((re * sf) / ra, 1.0 / sn);
  alat = 2.0 * Math.atan(alat) - Math.PI * 0.5;

  let theta: number;
  if (Math.abs(xn) <= 0) {
    theta = 0.0;
  } else if (Math.abs(yn) <= 0) {
    theta = Math.PI * 0.5;
    if (xn < 0) theta = -theta;
  } else {
    theta = Math.atan2(xn, yn);
  }
  const alon = theta / sn + olon;

  const lat = alat / DEGRAD;
  const lon = alon / DEGRAD;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

// 광역시·도의 대표 지점. 좌표가 **어느 동네를 가리키는지**를 사람 말로 바꾸기 위한
// 것이고, 행정 경계가 아니라 가장 가까운 대표 지점을 고를 뿐이다 — 그래서 화면 문구도
// "부근"이라고 적는다. 정확한 행정구역을 알려 주는 것이 목적이 아니라
// "제주 격자를 넣었다"를 관리자가 **한눈에** 알아채게 하는 것이 목적이다.
const REGIONS: { name: string; lat: number; lon: number }[] = [
  { name: "서울", lat: 37.57, lon: 126.98 },
  { name: "인천", lat: 37.46, lon: 126.71 },
  { name: "경기", lat: 37.29, lon: 127.05 },
  { name: "강원", lat: 37.72, lon: 128.2 },
  { name: "충북", lat: 36.79, lon: 127.66 },
  { name: "충남", lat: 36.62, lon: 126.85 },
  { name: "대전", lat: 36.35, lon: 127.38 },
  { name: "세종", lat: 36.48, lon: 127.29 },
  { name: "전북", lat: 35.72, lon: 127.15 },
  { name: "전남", lat: 34.87, lon: 126.99 },
  { name: "광주", lat: 35.16, lon: 126.85 },
  { name: "경북", lat: 36.3, lon: 128.8 },
  { name: "대구", lat: 35.87, lon: 128.6 },
  { name: "경남", lat: 35.35, lon: 128.35 },
  { name: "부산", lat: 35.18, lon: 129.08 },
  { name: "울산", lat: 35.54, lon: 129.31 },
  { name: "제주", lat: 33.43, lon: 126.56 },
];

/** 그 좌표에서 가장 가까운 광역시·도 이름. 위도에 따라 경도 1도의 실제 거리가 달라지므로 보정한다. */
export function nearestRegion(p: LatLon): string {
  let best = REGIONS[0]!;
  let bestD = Number.POSITIVE_INFINITY;
  for (const r of REGIONS) {
    const dy = r.lat - p.lat;
    const dx = (r.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180);
    const d = dy * dy + dx * dx;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best.name;
}

/**
 * 화면에 그대로 쓰는 한 줄. 예: `위도 37.303 · 경도 127.043 (경기 부근)`
 * 좌표가 쓸 수 없는 값이면 null — 그 경우는 격자 범위 검사가 따로 말한다.
 */
export function describeGrid(nx: unknown, ny: unknown): string | null {
  const p = gridToLatLon(nx, ny);
  if (!p) return null;
  return `위도 ${p.lat.toFixed(3)} · 경도 ${p.lon.toFixed(3)} (${nearestRegion(p)} 부근)`;
}
