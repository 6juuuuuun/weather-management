# 날씨경영 — 배포 전 수정 3건 (feat/magiclink-auth)

- 날짜: 2026-08-13
- 브랜치: `feat/magiclink-auth`
- 상태: 완료, 검증 전부 통과

## 요약

1. **인증을 봇 DM 매직링크로 교체 (OAuth 폐기)**
   - `supabase/functions/auth-kakaowork/index.ts`를 `POST ?action=request` 단일 액션으로 재작성.
     비멤버는 발송 없이 `{ok:true}`(열거 공격 방지), 멤버는 employees upsert(신규 staff·부서 null,
     ADMIN_KAKAOWORK_ID 일치 시 admin 승격) → `admin.generateLink` → 봇 DM 발송(`${APP_BASE_URL}/auth/callback#token_hash=...`).
     실패해도 항상 `{ok:true}` 반환, 서버 로그에만 에러 기록. 봇 키 없으면 멤버십 검증을 생략하고
     ConsoleChannel로 로컬 개발 가능.
   - **판단 편차 1건**: 스펙은 "GET ?action=callback"도 유지하라고 했으나, 새 흐름에서는 DM 링크가
     이미 프런트엔드 `${APP_BASE_URL}/auth/callback#token_hash=...`를 직접 가리키므로(웹의
     `AuthCallback.tsx`가 `verifyOtp` 수행) 이 콜백을 처리할 엣지 함수 라우트가 실제로 필요하지
     않았습니다. OAuth 코드를 전부 삭제하고 나면 이 라우트에 남는 유일한 형태는 "이메일을 쿼리
     파라미터로 받아 인증 없이 매직링크를 발급"하는 것뿐인데, 이는 새로 만든 열거 공격 방지·인증
     경계를 스스로 무너뜨리는 보안 구멍이라 판단해 구현하지 않았습니다. 대신 index.ts 상단에 이유를
     주석으로 남겼습니다. AuthCallback.tsx(웹)는 변경하지 않았습니다 — 그대로 `verifyOtp`를 수행합니다.
   - `supabase/config.toml`: verify_jwt=false 주석을 "OAuth 리다이렉트" → "로그인 전 POST 엔드포인트"로 정정.
   - 웹 로그인 화면(`apps/web/src/pages/Login.tsx`): 카카오워크 버튼 → 이메일 입력 폼으로 교체.
     `apps/web/src/lib/api.ts`에 `requestMagicLink(email)` 추가(`auth-kakaowork?action=request` invoke).
     제출 후 "카카오워크 앱을 확인해 주세요…" 안내 화면 + 다시 보내기. 코디네이터 추가 요구사항 반영:
     라벨/placeholder "카카오워크에 등록된 회사 이메일", 파인프린트에 "카카오워크 DM" 명시,
     실패 안내 문구를 "카카오워크에 등록된 이메일 주소가 맞는지 확인해 주세요"로 구체화.
     디자인은 tokens.css 변수만 사용, 웨이트 300/400/600 유지, 히어로 구조 그대로.
   - 테스트: `supabase/functions/auth-kakaowork/index_test.ts` 전면 재작성 — (a) 비멤버/빈 이메일도
     ok:true, (b) 신규 멤버 staff·부서 null 자동 가입, (c) ADMIN_KAKAOWORK_ID 승격(신규·기존 굳어진
     케이스 둘 다), (d) 발급된 token_hash로 `verifyOtp` 호출 시 세션이 실제로 확립됨을 검증.
     기존 mock 프로필 기반 테스트는 전량 대체. `apps/web/src/pages/Login.test.tsx`도 새 UI에 맞춰 재작성.
   - `.env.test` / `.env.test.example`에서 `MOCK_KAKAO_PROFILE` 제거. `.env.example`에서
     `KAKAOWORK_CLIENT_ID`/`KAKAOWORK_CLIENT_SECRET` 제거(더는 쓰이지 않음).
   - README: 아키텍처 설명·화면 캡션·"카카오워크 봇·OAuth 앱 등록" 절·환경변수 표·배포 체크리스트에서
     OAuth/`MOCK_KAKAO_PROFILE` 관련 서술을 매직링크 흐름에 맞게 정정(스코프 확장이지만, 그대로
     두면 존재하지 않는 OAuth 앱 등록·스파이크를 배포 조건으로 계속 지시하는 상태라 위험 판단).

2. **기상청 키 이중 인코딩**
   - `supabase/functions/_shared/kma.ts`: `normalizeKmaKey`/`buildKmaUrl` 추가 — 키에 `%`가 있으면
     (Encoding 키로 판단) 한 번 디코딩 후 인코딩해 정규화, 없으면(Decoding 키) 그대로 인코딩.
     `fetchObservation`이 이 함수를 사용하도록 리팩터링.
   - `kma_test.ts`에 URL 문자열 비교 단위 테스트 2건 추가(Decoding 키 그대로 인코딩 / Encoding 키가
     Decoding 키와 동일한 URL로 정규화됨).
   - README 인증키 안내에 "Encoding·Decoding 어느 쪽을 넣어도 동작합니다" 한 줄 추가.

3. **부서 미지정 직원 화면 게이트**
   - `apps/web/src/auth/RequireRole.tsx`: `requireDepartment?: boolean` prop 추가 — staff이면서
     `department_id === null`이고 requireDepartment면 `/`로 리다이렉트.
   - `apps/web/src/routes.tsx`: `/criteria`·`/guidelines`·`/events/:id`에 `requireDepartment` 적용
     (대시보드·이력은 미적용, 스펙대로).
   - `apps/web/src/pages/Dashboard.tsx` + `Dashboard.css`: 부서 미지정 staff에게 안내 배너
     "부서가 아직 지정되지 않았습니다. 관리자에게 부서 지정을 요청해 주세요." 추가(tokens.css 변수만 사용).
   - `apps/web/src/auth/RequireRole.test.tsx` 신규 — 4개 케이스(부서 미지정 차단/부서 지정 허용/
     requireDepartment 미지정 시 허용/admin은 부서 무관 허용).

## 검증 결과 (전부 통과)

```
supabase db reset                                                  → OK (마이그레이션 6건 + 시드)
supabase functions serve --env-file .env.test (백그라운드)          → 기동 성공
deno check <_shared 5개 + weather-tick/remind-tick/send/auth-kakaowork> → 통과 (에러 0)
deno test --allow-net --allow-env supabase/functions/ scripts/scenario-test.ts → 59 passed, 0 failed
cd apps/web && npx vitest run                                      → 7 files / 35 tests passed
cd apps/web && npm run build                                       → tsc -b && vite build 성공
```

`.env.test`에서 `MOCK_KAKAO_PROFILE` 제거 완료, `.env.test.example`도 갱신.

## 리뷰 반영 (보안 소견 2건 + 1건, 2026-08-13)

1. **[Critical] 타이밍 사이드채널로 멤버십 열거 가능 → 수정 완료**
   `handleRequest`가 응답 전에 수행하는 작업을 멤버/비멤버 양쪽 모두 "멤버십 조회 1회"로 통일했다.
   조회 이후의 모든 작업(employees upsert·createUser·generateLink·DM 발송, 특히 카카오워크 API
   왕복 2회가 드는 DM 발송)은 `provisionAndNotify()`로 분리해 응답 이후 백그라운드로 넘긴다.
   `runBackground()`가 `EdgeRuntime.waitUntil`이 있으면 그걸 쓰고, 없으면(로컬 `deno test` 등)
   fire-and-forget으로 처리하며 실패는 콘솔 로그로만 남긴다.
2. **[Important] 봇 키 부재 시 fail-open → fail-closed로 수정**
   `_shared/kakaowork.ts`에 `isLocalUrl` 추가(기존 OAuth 코드의 하드 가드 패턴 재사용).
   `KAKAOWORK_BOT_KEY`가 없고 `SUPABASE_URL`·`APP_BASE_URL` 둘 다 로컬이 아니면 계정 생성/링크
   발급 없이 `{ok:true}` + 콘솔 에러 로그("봇 키 미설정 — 요청 무시")만 남기고 종료. 로컬(둘 다
   로컬 URL)일 때만 예외적으로 허용해 ConsoleChannel 경로로 로컬 개발이 가능하게 유지.
3. **[Minor] 멤버십 조회 예외 미처리 → try/catch 추가**
   `resolveKakaoworkUserIdByEmail` 호출을 try/catch로 감싸 카카오워크 API 장애 시에도 `{ok:true}`
   불변식이 깨지지 않게 함.

**테스트 보강**:
- `_shared/kakaowork_test.ts`에 `isLocalUrl` 단위 테스트 2건(로컬 URL 3종 판정 / 프로덕션·undefined
  는 로컬 아님). "봇 키 없음 + 비로컬 URL이면 계정 미생성"은 이 순수 함수 단위 테스트로 결정론적으로
  검증했다 — 로컬 통합 테스트 하네스(`supabase functions serve --env-file .env.test`)는 항상 로컬
  URL로만 뜨기 때문에 그 조합을 통합 테스트로 직접 재현할 수 없어, 분기 로직 자체를 단위 테스트하는
  쪽을 택했다(기존 저장소 컨벤션 — 순수 로직은 `_shared/*_test.ts`, 엔트리포인트는 HTTP 통합 테스트).
- `auth-kakaowork/index_test.ts`: 계정 생성이 백그라운드로 넘어가면서 응답 직후 employees를 조회하면
  아직 반영 전일 수 있어, `waitForEmployee`/`pollUntil` 폴링 헬퍼를 추가해 기존 4개 테스트를 여기에
  맞춰 조정. 새로 깨진 테스트 없이 전부 통과.

재검증 결과: `deno check` 9개 파일 통과, `deno test --allow-net --allow-env supabase/functions/
scripts/scenario-test.ts` → **59 passed, 0 failed**, `cd apps/web && npx vitest run && npm run build`
→ 35 tests passed + build 성공.

## 우려 사항 / 후속 검토 필요

- **판단 편차**: 위 "GET ?action=callback" 미구현 건 — 스펙 문구와 다른 선택을 했습니다. 새 흐름에서
  실제로 세션을 발급하는 코드 경로(`verifyOtp`)는 웹의 `AuthCallback.tsx`이며, 엣지 함수 쪽에 남길
  합리적인 콜백 라우트를 찾지 못해 보안을 우선했습니다. 의도와 다르면 알려주시면 라우트를 추가하겠습니다.
- README의 아키텍처·배포 체크리스트·환경변수 표까지 정정한 것은 사용자가 명시한 3건 범위를 넘는
  변경입니다(그대로 두면 존재하지 않는 OAuth 앱 등록을 배포 조건으로 계속 안내하게 되어 수정함).
  범위 확장이 과했다면 되돌리겠습니다.
- 실서비스 카카오워크 봇 키로 DM 왕복(요청 → 실제 DM 수신 → 클릭 → 세션 확립)까지는 로컬
  ConsoleChannel 경로로만 검증했습니다. 실 배포 전 실제 워크스페이스로 왕복 스파이크가 필요합니다
  (README 배포 체크리스트에 명시해 두었습니다).
- `.env`(로컬 실제 비밀키 파일)는 건드리지 않았습니다 — gitignore 대상이라 커밋 위험은 없지만,
  `KAKAOWORK_CLIENT_ID`/`KAKAOWORK_CLIENT_SECRET` 등 더 이상 쓰이지 않는 값이 남아 있을 수 있습니다.
