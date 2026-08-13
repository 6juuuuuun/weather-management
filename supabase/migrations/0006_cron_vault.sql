-- pg_cron이 Edge Function을 호출할 때 쓰는 설정값의 출처를 Vault로 옮긴다.
--
-- 배경: 0003에서는 `current_setting('app.edge_base_url')`를 썼는데, Supabase 관리형
-- 인스턴스에서는 `alter database ... set`에 필요한 권한이 없어 값을 넣을 수 없다.
-- Vault(supabase_vault)는 관리형에서 공식 지원되는 비밀 저장소이므로 이를 1순위로 읽고,
-- 로컬 개발(Vault 미설정)에서는 기존 current_setting 경로로 폴백한다.
--
-- 값 주입은 마이그레이션이 아니라 배포 시 1회 수행한다(비밀이 git에 남지 않도록):
--   select vault.create_secret('<함수 베이스 URL>', 'edge_base_url');
--   select vault.create_secret('<CRON_SECRET>',     'cron_secret');

create or replace function call_edge(fn text) returns void language plpgsql
security definer set search_path = public, vault as $$
declare
  base text;
  secret text;
begin
  select decrypted_secret into base   from vault.decrypted_secrets where name = 'edge_base_url' limit 1;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret'   limit 1;

  -- 로컬 개발 폴백
  base   := coalesce(base,   current_setting('app.edge_base_url', true));
  secret := coalesce(secret, current_setting('app.cron_secret', true));

  if base is null or secret is null then
    raise notice 'call_edge(%): 설정 없음 — 호출 건너뜀', fn;
    return;
  end if;

  perform net.http_post(
    url := base || '/' || fn,
    headers := jsonb_build_object('x-cron-secret', secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb);
end $$;
