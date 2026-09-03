// 모든 테스트 파일보다 먼저 돈다(server/vitest.config.ts의 setupFiles).
//
// 서버 테스트는 저장소 루트 .env를 그대로 읽는다(vitest.config.ts의 loadRootEnv).
// 거기에 **실제 발송 제공자 설정**이 들어 있으면, 발송 경로를 하나라도 밟은
// 테스트가 진짜 문자를 내보낸다 — 리조트 직원들 휴대폰으로 테스트 메시지가 갈 수도
// 있다는 뜻이다. 예전에는 파일마다 맨 위에서 채널을 덮어써 막았는데, 그 한 줄을
// 빠뜨린 파일이 생기면 조용히 뚫린다(그리고 그 사실은 사고가 난 뒤에야 알게 된다).
// 여기 한 곳에서 못박는다: SMS_PROVIDER가 비면 getChannel이 로그 전용을 준다.
//
// 지금은 제공자 구현 자체가 없어 실발송이 불가능하지만, 이 한 줄은 **제공자가
// 붙는 날**을 위한 것이다. 그날 이 파일을 고치는 사람은 없다.
process.env.SMS_PROVIDER = "";

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
