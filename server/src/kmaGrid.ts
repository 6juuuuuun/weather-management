// 기상청 단기예보 격자(nx, ny)의 유효 범위.
//
// 한 곳에만 둔다. 저장을 막는 쪽(api/dashboard.ts의 PATCH /site-settings)과
// 이미 저장된 잘못된 값을 드러내는 쪽(jobs/watchdog.ts)이 **반드시 같은 범위**를
// 써야 하기 때문이다. 두 벌로 적으면 한쪽만 고쳐져서, 저장은 막히는데 화면은
// 여전히 초록이거나 그 반대가 된다 — 이 결함(QA W-10)의 본질이 정확히 그
// "막는 곳과 보이는 곳의 어긋남"이다.
//
// 값은 기상청 동네예보 격자 정의 그대로다(nx 1~149, ny 1~253). 이 범위를
// 벗어난 좌표로는 API가 자료를 돌려주지 않아 매시간 수집이 실패한다.
export const GRID_NX_MAX = 149;
export const GRID_NY_MAX = 253;

export function isValidGrid(nx: unknown, ny: unknown): boolean {
  return (
    typeof nx === "number" && Number.isInteger(nx) && nx >= 1 && nx <= GRID_NX_MAX &&
    typeof ny === "number" && Number.isInteger(ny) && ny >= 1 && ny <= GRID_NY_MAX
  );
}
