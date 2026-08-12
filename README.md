# 날씨경영

날씨 이벤트(폭우·폭설·강풍·폭염)가 임계값을 넘으면 자동으로 감지해 사업부장에게 알리고,
부서별로 미리 등록해 둔 행동 지침을 조합해 메시지 초안을 만들며, 사업부장 검토·승인 후
각 부서 담당자에게 카카오워크로 발송하는 시스템입니다. 리조트 운영 조직(예: 곤지암리조트류)을
염두에 두고 만들었고, 오픈소스 파일럿으로 누구나 클론해 자신의 조직에 붙일 수 있게 설계했습니다.

역할 구조는 Human-in-the-loop입니다: **System**(감지·조합·발송) → **사업부장**(승인·편집) → **실무자**(이행).

설계 배경과 결정 사항의 전체 맥락은 [`docs/superpowers/specs/2026-08-12-weather-management-design.md`](docs/superpowers/specs/2026-08-12-weather-management-design.md)에 정리되어 있습니다.

## 1. 소개

### 아키텍처

```
React SPA (Vite, Vercel) ── supabase-js ──► Supabase
                                            ├─ Postgres (+ RLS)
                                            ├─ pg_cron: 매시 정각 weather-tick, 매 10분 remind-tick
                                            └─ Edge Functions (Deno/TS)
                                               ├─ weather-tick  ← 기상청 공공 API
                                               ├─ remind-tick
                                               ├─ send          → 카카오워크 봇 API
                                               └─ auth-kakaowork
```

- **React SPA**: 로그인 + 대시보드 + 화면 5개(기준 정의·지침 등록·초안 검토/발송·발송 이력·알림 설정·직원 관리).
  조회·설정 수정은 supabase-js로 직접 접근(RLS로 권한 강제)하고, 부수효과가 있는 동작(발송)만 Edge
  Function을 호출합니다.
- **weather-tick** (매시 정각): 기상청 초단기실황을 조회해 `weather_observations`에 저장하고,
  임계값을 평가해 특보를 생성(`PENDING_APPROVAL`)·초안을 조합·사업부장에게 카카오워크로 알립니다.
  활성 특보의 반복발송·해제·격상 조건도 매 실행 시 함께 평가합니다.
- **remind-tick** (매 10분): `PENDING_APPROVAL` 상태로 재알림 간격이 지나면 사업부장에게 다시 알립니다.
- **send**: 사업부장의 승인/무시/재발송 요청을 처리합니다. 승인 시 메시지 스냅샷을 확정해
  부서별 수신자에게 발송하고 `dispatches`에 기록합니다.
- **auth-kakaowork**: 카카오워크 OAuth 콜백 → 직원 매칭/자동 가입 → Supabase 세션 발급.
- **NotificationChannel 어댑터**: 카카오워크 구현체 + 콘솔/로그 구현체. 다른 채널(알림톡 등)을
  붙이고 싶은 오픈소스 사용자를 위한 확장 지점입니다 (§6 참고).

### 화면

| ![대시보드](design/previews/00-dashboard.png) | ![초안 검토·발송](design/previews/03-event-review.png) | ![로그인](design/previews/07-login.png) |
|:---:|:---:|:---:|
| 대시보드 — 셋업 체크리스트·승인 대기·관측값 | 초안 검토·발송 — 부서 블록 편집·승인 | 로그인 — 카카오워크 OAuth 단일 버튼 |

그 외 화면 미리보기는 `design/previews/`에 모두 있습니다 (기준 정의·지침 등록·발송 이력·알림 설정·직원 관리 등).

## 2. 사전 준비

### 기상청 공공데이터 API 키 발급

1. [공공데이터포털](https://www.data.go.kr)에 가입 후 **기상청_단기예보 조회서비스**(서비스 ID `15084084`)를
   활용신청합니다. 자동승인이라 신청 즉시 사용할 수 있습니다.
2. 마이페이지 → 개발계정 상세보기에서 **일반 인증키(Decoding)**를 복사합니다. 이 값이 `KMA_API_KEY`입니다.
3. 관측 지점의 기상청 격자좌표(nx, ny)도 함께 확인해 두세요 — 설치 후 `site_settings`(설정 화면)에서 입력합니다.

### 카카오워크 봇·OAuth 앱 등록

1. 카카오워크 관리자 콘솔 → 앱 관리에서 **커스텀 봇을 생성**합니다. 발급된 **App Key**가 `KAKAOWORK_BOT_KEY`입니다.
2. 같은 관리자 콘솔에서 **OAuth 앱**을 등록해 `KAKAOWORK_CLIENT_ID` / `KAKAOWORK_CLIENT_SECRET`을 발급받고,
   리다이렉트 URI를 배포한 `auth-kakaowork` Edge Function의 콜백 주소(`.../functions/v1/auth-kakaowork?action=callback`)로
   등록합니다.
3. **중요**: 카카오워크 무료 플랜에서의 워크봇 API 가용 여부와 OAuth 연동 가능 여부는 조직마다 다를 수 있습니다.
   실 배포 전에 반드시 실제 워크스페이스로 OAuth 왕복(로그인 → 콜백 → 세션 발급)까지 스파이크로 검증하세요
   (§3 배포 체크리스트 참고).

### Supabase 프로젝트 생성

[supabase.com](https://supabase.com)에서 새 프로젝트를 만들고 프로젝트 참조 ID(ref)와
`anon`/`service_role` 키를 기록해 둡니다.

## 3. 설치 (프로덕션 배포)

```bash
# 1) 로컬 저장소를 원격 Supabase 프로젝트에 연결
supabase link --project-ref <project-ref>

# 2) 마이그레이션 적용 (스키마 + RLS + pg_cron + 시드)
supabase db push

# 3) Edge Function 배포
supabase functions deploy weather-tick remind-tick send auth-kakaowork

# 4) 비밀값 등록 (아래 환경변수 표 참고)
supabase secrets set --env-file .env.production

# 5) pg_cron이 Edge Function을 호출할 수 있도록 DB 설정값 등록 (0003_cron.sql 참고)
#    SQL Editor 또는 psql로 실행:
#    alter database postgres set app.edge_base_url = 'https://<project-ref>.supabase.co/functions/v1';
#    alter database postgres set app.cron_secret = '<CRON_SECRET과 동일한 값>';

# 6) apps/web을 Vercel/Netlify 등 정적 호스팅에 배포 (빌드: npm run build, 산출물: apps/web/dist)
```

### 환경변수

| 변수 | 위치 | 설명 |
|---|---|---|
| `VITE_SUPABASE_URL` | `apps/web` 빌드 | Supabase 프로젝트 URL |
| `VITE_SUPABASE_ANON_KEY` | `apps/web` 빌드 | Supabase anon key |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions (Supabase가 자동 주입) | DB 접근용 |
| `KMA_API_KEY` | Edge Functions secrets | 기상청 공공데이터 일반 인증키(Decoding) |
| `KAKAOWORK_BOT_KEY` | Edge Functions secrets | 카카오워크 커스텀 봇 App Key |
| `KAKAOWORK_CLIENT_ID` / `KAKAOWORK_CLIENT_SECRET` | Edge Functions secrets | 카카오워크 OAuth 앱 자격증명 |
| `ADMIN_KAKAOWORK_ID` | Edge Functions secrets | 최초 시스템관리자로 지정할 카카오워크 로그인 이메일 |
| `CRON_SECRET` | Edge Functions secrets + DB `app.cron_secret` | pg_cron → Edge Function 호출 인증용 임의 문자열 |
| `APP_BASE_URL` | Edge Functions secrets | 웹 콘솔 URL (OAuth 리다이렉트·딥링크 생성용) |
| `NOTIFY_CHANNEL` | Edge Functions secrets (선택) | `console`로 설정하면 카카오워크 대신 로그 채널 사용 (개발/시연용) |

전체 목록과 형식은 저장소 루트의 [`.env.example`](.env.example), 웹 앱용은
[`apps/web/.env.example`](apps/web/.env.example)을 참고하세요.

### 배포 체크리스트 (반드시 확인)

- [ ] **`MOCK_KAKAO_PROFILE`을 프로덕션 Supabase secrets에 절대 설정하지 않는다.** 이 값이 설정되면
  `auth-kakaowork`가 실제 OAuth 검증을 건너뛰고 아무나 지정된 프로필로 로그인할 수 있는
  테스트 전용 백도어이므로, 로컬/CI 환경(`.env.test`)에서만 사용해야 합니다.
- [ ] **카카오워크 실 OAuth 왕복 스파이크를 배포 착수 조건으로 삼는다.** 로그인 → 콜백 → 세션 발급까지
  실제 워크스페이스에서 성공하는지 먼저 검증하세요. 실패한다면(무료 플랜 제약 등) 카카오워크 봇의
  DM으로 매직링크를 발송해 로그인시키는 대안으로 전환할지 검토해야 합니다.
- [ ] **`ADMIN_KAKAOWORK_ID`를 설정한 뒤, 그 이메일 계정으로 첫 로그인**해 시스템관리자 권한을 확보한다
  (§4 참고). 설정을 빠뜨리면 관리자가 0명인 채로 시작하게 됩니다.
- [ ] `app.edge_base_url` / `app.cron_secret` DB 설정을 마쳐 pg_cron이 정상 동작하는지 확인한다
  (대시보드의 "마지막 수집 N분 전" 표시로 확인 가능).

## 4. 최초 로그인

1. `ADMIN_KAKAOWORK_ID`로 지정한 카카오워크 계정으로 로그인합니다. `auth-kakaowork`가 이 계정을
   자동으로 시스템관리자(`admin`) 역할로 부여합니다 (기존 사용자였어도 승격되며, 강등은 하지 않습니다).
2. 대시보드 상단의 **셋업 체크리스트**를 순서대로 진행합니다. 5개 항목을 모두 완료하기 전에는
   시스템이 발송을 시작할 수 없습니다.
   1. **관측 지점** — 설정 화면에서 기상청 격자좌표(nx, ny)와 지점명을 입력합니다.
   2. **특보 기준** — 4종(폭우·폭설·강풍·폭염) × 2등급(주의보·경보) 임계값을 확인/조정합니다
      (기상청 특보 기준 프리셋이 시드되어 있습니다).
   3. **부서 구성** — 직원 관리 화면의 부서 관리 모달에서 부서 트리를 만듭니다.
   4. **부서별 지침** — 지침 등록 화면에서 종류×등급×부서별로 인력 조정 지침과 고객 안내 멘트를 등록합니다.
   5. **Alert 수신자** — 특보 발생 시 승인 알림을 받을 사업부장을 지정합니다.
3. 이후 가입하는 직원은 카카오워크 로그인만으로 자동 가입되며 역할은 실무자, 부서는 미지정 상태입니다.
   직원 관리 화면의 "부서 미지정 N명" 필터로 걸러 부서를 지정해 주세요.

## 5. 로컬 개발

```bash
supabase start                                       # 로컬 Supabase 스택 기동
supabase db reset                                     # 스키마 + RLS + 시드 적용
supabase functions serve --env-file .env.test          # Edge Functions 로컬 서빙 (터미널 1)
cd apps/web && npm run dev                              # React 개발 서버 (터미널 2)
```

`.env.test`는 로컬 전용 값(콘솔 알림 채널, mock 카카오 프로필 등)을 담고 있습니다.
`supabase start`가 출력하는 `anon key`를 `apps/web/.env`(`.env.example` 복사)의
`VITE_SUPABASE_ANON_KEY`에 채워 넣으세요.

### 테스트 명령

```bash
# Deno 단위/통합 테스트 (supabase start + db reset + functions serve 필요)
deno test --allow-net --allow-env supabase/functions/

# 전 구간 시나리오 테스트 (감지 → 승인 → 반복발송 → 격상 → 해제)
deno test --allow-net --allow-env scripts/scenario-test.ts

# 웹 앱 단위 테스트 (Vitest)
cd apps/web && npx vitest run

# 웹 앱 빌드 검증
cd apps/web && npm run build
```

전부 한 번에 확인하려면:

```bash
supabase db reset
deno test --allow-net --allow-env supabase/functions/ scripts/scenario-test.ts \
  && (cd apps/web && npx vitest run) \
  && (cd apps/web && npm run build)
```

## 6. 라이선스 · 확장

MIT License — [`LICENSE`](LICENSE) 참고. 자유롭게 포크·수정·재배포할 수 있습니다.

### 알림 채널 확장하기

카카오워크 외 채널(알림톡, 슬랙, 이메일 등)을 붙이려면 `supabase/functions/_shared/channel.ts`의
`NotificationChannel` 인터페이스(`send(kakaoworkUserId, text): Promise<{ok, error?}>`)를 구현하는
클래스를 하나 추가하고, `_shared/kakaowork.ts`의 `getChannel()`이 환경변수에 따라 그 구현체를
반환하도록 분기를 추가하면 됩니다 (기존 `KakaoWorkChannel`/`ConsoleChannel`이 참고 예시입니다).
