-- Supabase가 제공하던 auth 스키마를 자체 정의한다. 권한 정책 14개가 auth.uid()
-- 하나에만 의존하므로, 이 함수만 우리가 채우면 정책은 한 줄도 고치지 않아도 된다.
begin;

-- 주의: 아래 create schema/create function은 0000_auth_bootstrap.sql과 동일 정의를
-- 중복으로 갖고 있다(0002_rls.sql의 create policy가 auth.uid()를 먼저 요구해서 0000이
-- 앞자리 번호로 따로 존재한다). 이 파일은 브리프 원문 대조를 위해 고치지 않기로 했으니,
-- 아래를 고치면 0000_auth_bootstrap.sql의 동일 블록도 같이 고칠 것.
create schema if not exists auth;

-- Express가 트랜잭션마다 SET LOCAL로 넣는 값을 읽는다.
-- 값이 없으면 null이고, 그때 정책들은 아무 행도 통과시키지 않는다(안전한 기본값).
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- 애플리케이션 역할: 정책을 적용받는다.
create role app_user nologin;
grant usage on schema public, auth to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_user;

-- 서버 로직 역할: 수집·발송은 특정 사용자를 대신하는 것이 아니므로 정책을 우회한다.
create role app_service nologin bypassrls;
grant usage on schema public, auth to app_service;
grant select, insert, update, delete on all tables in schema public to app_service;
grant usage, select on all sequences in schema public to app_service;
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_service;

commit;
