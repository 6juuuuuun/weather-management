// 모든 테스트 파일보다 먼저 돈다(server/vitest.config.ts의 setupFiles).
//
// 서버 테스트는 저장소 루트 .env를 그대로 읽는다(vitest.config.ts의 loadRootEnv).
// 거기에는 **실제 카카오워크 봇 키**가 들어 있어서, 발송이나 사용자 조회를 하는
// 코드 경로를 하나라도 밟으면 테스트가 진짜 카카오워크 API로 나간다 — 리조트
// 직원들에게 테스트 메시지가 갈 수도 있다는 뜻이다. 예전에는 파일마다 맨 위에서
// NOTIFY_CHANNEL을 console로 덮어써 이 문제를 막았는데, 그 한 줄을 빠뜨린 파일이
// 생기면 조용히 뚫린다(그리고 그 사실은 사고가 난 뒤에야 알게 된다).
// 여기 한 곳에서 못박는다. 실제 키가 필요한 테스트는 스스로 값을 넣고 되돌린다.
process.env.NOTIFY_CHANNEL = "console";
process.env.KAKAOWORK_BOT_KEY = "";

// 로그인 속도 제한(src/auth/rateLimit.ts)은 프로세스 메모리에 남는 상태다 —
// DB의 표와 성격이 같아서, 테스트가 시작할 때 비워 주지 않으면 **앞 테스트가 만든
// 실패 기록 때문에 뒤 테스트가 429로 죽는다.** 한 파일 안에서 잘못된 비밀번호를
// 수십 번 넣는 파일이 여럿이라 실제로 그렇게 됐다(항목 8과 같은 종류의 오염).
//
// 이 초기화가 "속도 제한이 사실상 꺼진 상태"를 만들지 않는지는
// test/login-rate-limit.test.ts가 **한 테스트 안에서** 연속 시도를 쌓아 확인한다.
import { beforeEach } from "vitest";
import { loginRateLimiter } from "../src/auth/rateLimit.ts";

beforeEach(() => {
  loginRateLimiter.reset();
});
