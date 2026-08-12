import { KakaoWorkChannel, resolveKakaoworkUserIdByEmail } from "../supabase/functions/_shared/kakaowork.ts";
const key = Deno.env.get("KAKAOWORK_BOT_KEY")!;
const email = Deno.args[0];
const uid = await resolveKakaoworkUserIdByEmail(key, email);
if (!uid) { console.error("user not found:", email); Deno.exit(1); }
console.log(await new KakaoWorkChannel(key).send(uid, "[날씨경영] 스모크 테스트 메시지입니다."));
