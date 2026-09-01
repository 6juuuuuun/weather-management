// 하루 한 번 미연결 직원의 카카오워크 연결을 다시 시도한다.
//
// 가입·직원등록·이메일수정 시점에 이미 한 번씩 시도하지만, 연결이 안 되는 흔한 원인은
// 나중에 고쳐진다: 설치 직후엔 봇 키가 아직 없고, 카카오워크 계정이 직원보다 늦게
// 만들어지기도 하고, 이메일 오타를 며칠 뒤에 고친다. 그 사람들이 영원히 미연결로
// 남으면 특보가 그만큼 덜 전달된다.
import { relinkUnlinked } from "../kakaoLink.ts";
import { upsertHeartbeat } from "./weatherTick.ts";

export async function runKakaoLinkTick(): Promise<{ candidates: number; linked: number }> {
  const out = await relinkUnlinked();
  await upsertHeartbeat("kakao-link", true, `${out.linked}/${out.candidates}`);
  return out;
}
