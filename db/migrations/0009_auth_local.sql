-- Supabase Auth가 갖고 있던 계정 정보를 우리 테이블로 가져온다.
begin;

create table auth_accounts (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  -- 가입하면 바로 쓸 수 있다. 사내 DNS로만 열리므로 가입 화면에 닿는 것 자체가
  -- 1차 관문이고, 가입해도 staff라 조회만 된다. 실제 관문은 관리자의 역할 부여다.
  -- disabled는 퇴사자나 사고 계정을 막기 위해 남긴다.
  status text not null default 'active' check (status in ('active','disabled')),
  -- 관리자가 임시 비밀번호를 발급하면 참이 되고, 다음 로그인에서 변경을 강제한다.
  must_change_password boolean not null default false,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create table auth_sessions (
  -- 쿠키에는 원문 토큰이 가고 여기에는 해시만 남긴다. DB가 유출돼도
  -- 세션을 그대로 재사용할 수 없게 한다.
  token_hash text primary key,
  account_id uuid not null references auth_accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index on auth_sessions (account_id);
create index on auth_sessions (expires_at);

-- 기존 employees.auth_user_id가 이 계정을 가리킨다.
alter table employees
  add constraint employees_auth_account_fk
  foreign key (auth_user_id) references auth_accounts(id) on delete set null;

-- 가입 시 본인이 입력한다. 알림톡·SMS는 이 번호로 나가므로 없으면 발송 대상이 없다.
-- 기존 스키마에 없던 컬럼이라 여기서 더한다.
alter table employees add column if not exists phone text;

commit;
