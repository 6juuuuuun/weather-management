-- 0002_rls.sql의 create policy 문은 auth.uid()를 즉시 OID로 해석해야 해서(함수 본문과
-- 달리 check_function_bodies로 미룰 수 없다), auth 스키마와 함수가 그 전에 있어야 한다.
-- 0008_selfhost_auth.sql이 파일명 순서상 맨 뒤에 적용되므로, 정책 이관을 그대로 두려면
-- 이 부트스트랩만 앞으로 뺀다. 0008도 동일 정의를 idempotent하게(if not exists /
-- or replace) 다시 선언하므로 두 번 실행돼도 안전하다 — 역할·권한(app_user/app_service)은
-- 그쪽에 그대로 둔다.
--
-- 주의: 아래 create schema/create function은 0008_selfhost_auth.sql에 그대로
-- 다시 나온다(0008은 브리프 원문 대조를 위해 고치지 않기로 함). 여기를 고치면
-- 0008의 동일 블록도 같이 고칠 것 — 둘이 어긋나면 실행 순서상 이 파일의 정의가
-- 이기고 0008의 수정은 조용히 무시된다.
create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;
