create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 프로덕션 배포 후 실제 값으로 갱신: select vault 또는 alter database ... set
-- 로컬에선 functions serve URL 사용
create or replace function call_edge(fn text) returns void language plpgsql as $$
declare
  base text := current_setting('app.edge_base_url', true);
  secret text := current_setting('app.cron_secret', true);
begin
  perform net.http_post(
    url := base || '/' || fn,
    headers := jsonb_build_object('x-cron-secret', secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb);
end $$;

select cron.schedule('weather-tick-hourly', '5 * * * *',  $$select call_edge('weather-tick')$$);
select cron.schedule('remind-tick-10min',  '*/10 * * * *', $$select call_edge('remind-tick')$$);
