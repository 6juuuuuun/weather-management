// node-cron@^3.0.3는 타입 선언을 내장하지 않고 @types/node-cron도 설치돼 있지 않다
// (의존성을 새로 추가하지 말라는 제약 때문에 @types 패키지도 추가하지 않는다).
// 여기서 실제로 쓰는 API(schedule)만 최소한으로 선언해 tsc 오류 없이 타입을 받는다.
declare module "node-cron" {
  export function schedule(expression: string, fn: () => void | Promise<void>): { stop(): void };
}
