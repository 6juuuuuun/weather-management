-- auth_accounts/auth_sessions는 지금 withService(app_service, bypassrls)로만 접근하는
-- 설계라 실질적인 노출 경로는 없다. 그래도 심층 방어로 RLS를 켠다 — 나중에 누가 실수로
-- withUser(app_user) 경로에서 이 테이블을 조회하는 코드를 추가하더라도, 정책을 하나도
-- 만들지 않으면 RLS가 켜진 테이블은 기본적으로 모든 행을 막는다(app_user에게는 항상
-- 0행). app_service는 bypassrls라 지금처럼 그대로 전체를 본다.
--
-- 정책을 만들지 않는 이유: 세션 해시·비밀번호 해시는 애초에 app_user 경로로 노출되면
-- 안 되는 값이다. "이런 조건이면 보여준다"는 규칙 자체를 만들지 않는 편이, 나중에
-- 조건을 잘못 적어 조용히 열리는 것보다 안전하다.
begin;

alter table auth_accounts enable row level security;
alter table auth_sessions enable row level security;

commit;
