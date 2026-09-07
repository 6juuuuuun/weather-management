-- db/migrations/0018_weather_forecasts.sql
-- 기상청 단기예보 보관. weather_observations와 같은 자리에 같은 방식으로 둔다.
--
-- 왜 저장하는가: 받아서 화면에 바로 흘려보내면 기상청이 죽었을 때 화면이 빈다.
-- 그리고 "예보가 멈췄다"를 아무도 모른다 — 이 프로젝트가 여섯 라운드 내내
-- 고친 결함이 전부 그 모양이었다. 저장하면 마지막 값과 그것을 언제 받았는지가
-- 함께 남아, 화면과 워치독이 낡음을 말할 수 있다. 5일 × 24시간 = 약 120행뿐이다.
create table weather_forecasts (
  fcst_at    timestamptz primary key,
  temp_c     numeric,
  pop_pct    integer,
  pty        integer,
  sky        integer,
  -- PCP·SNO는 기상청이 한글 문자열로 준다("강수없음"). 읽지 못한 값은 여기에
  -- null로 들어온다 — 0으로 뭉개면 "모른다"가 "비 안 온다"로 둔갑한다.
  pcp_mm     numeric,
  sno_cm     numeric,
  wsd_ms     numeric,
  reh_pct    integer,
  -- 기상청이 하루 중 특정 시각 행에만 실어 준다. 대부분의 행에서는 null이다.
  tmn_c      numeric,
  tmx_c      numeric,
  base_at    timestamptz not null,
  fetched_at timestamptz not null default now()
);

alter table weather_forecasts enable row level security;

-- weather_observations와 같은 정책. 로그인한 사람은 읽고, 쓰기는 app_service만
-- (bypassrls). 예보에는 개인정보가 없지만 정책을 빼면 이 테이블만 예외가 되고,
-- 다음 사람이 "왜 얘만 다른가"를 다시 추적해야 한다.
create policy r_all on weather_forecasts for select using (auth.uid() is not null);
