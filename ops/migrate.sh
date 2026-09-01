#!/bin/sh
# 데이터베이스 스키마를 최신 상태로 맞춘다.
#
# 운영자가 직접 부를 일은 거의 없다 — docker-compose.yml의 migrate 서비스가
# `docker compose up -d` 때마다 앱보다 먼저 이 스크립트를 돌린다. 그래서
# "몇 번을 돌려도 안전할 것"이 이 스크립트의 유일한 요구사항이다.
#
# db/migrations/*.sql은 다시 돌리면 깨진다(create type/create table에 if not
# exists가 없다). 그래서 어떤 파일을 이미 적용했는지 schema_migrations 테이블에
# 기록해 두고, 기록에 없는 파일만 적용한다. db/seed.sql은 원래부터 여러 번
# 돌려도 안전하게 되어 있어(on conflict do nothing) 매번 적용한다.
#
# 필요한 환경변수:
#   DATABASE_URL         슈퍼유저 접속 문자열
#   APP_USER_PASSWORD    0010_role_login.sql이 app_user 역할에 부여할 비밀번호
#   APP_SERVICE_PASSWORD 같은 파일이 app_service 역할에 부여할 비밀번호
# 비밀번호는 이 파일에 적지 않는다 — 환경에서만 읽고, psql에는 -v로 넘겨
# :'변수' 구문으로 꽂는다(psql이 SQL 리터럴로 안전하게 인용한다).
set -eu

: "${DATABASE_URL:?DATABASE_URL이 필요합니다}"
: "${APP_USER_PASSWORD:?APP_USER_PASSWORD가 필요합니다}"
: "${APP_SERVICE_PASSWORD:?APP_SERVICE_PASSWORD가 필요합니다}"

DB_DIR="${DB_DIR:-/db}"
MIG_DIR="$DB_DIR/migrations"
[ -d "$MIG_DIR" ] || { echo "마이그레이션 폴더를 찾을 수 없습니다: $MIG_DIR" >&2; exit 1; }

# psql -c로 준 문장은 psql의 변수 치환(:'fn')을 거치지 않고 서버로 그대로 간다 —
# 실제로 `syntax error at or near ":"`로 확인했다. 문장을 표준입력으로 흘려
# -f - 로 읽혀야 치환이 일어난다. 값을 SQL에 이어 붙이지 않기 위한 통로가
# 이것뿐이므로 모든 질의를 이 함수로 보낸다.
#   sql "<문장>" [psql 추가 인자...]
sql() {
  _text="$1"
  shift
  printf '%s\n' "$_text" | command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@" -f -
}

# Postgres가 아직 접속을 받지 않는 순간이 있다(컨테이너는 떴는데 초기화 중).
# compose의 depends_on healthy가 대부분 막아 주지만, 사람이 직접 부를 때를
# 대비해 여기서도 잠깐 기다린다.
i=0
until sql "select 1" -q >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then echo "데이터베이스에 접속할 수 없습니다" >&2; exit 1; fi
  echo "데이터베이스를 기다리는 중... ($i/30)"
  sleep 2
done

sql "create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
)" -q

# 이 스크립트가 생기기 전에 손으로 마이그레이션을 적용해 둔 데이터베이스를
# 받아들인다. 스키마는 이미 있는데 기록만 비어 있는 상태에서 그냥 진행하면
# 처음부터 다시 적용하려다 "type ... already exists"로 멈춘다.
applied_count=$(sql "select count(*) from schema_migrations" -tA)
has_schema=$(sql "select case when to_regclass('public.employees') is null then 0 else 1 end" -tA)
if [ "$applied_count" = "0" ] && [ "$has_schema" = "1" ]; then
  echo "이미 만들어진 데이터베이스입니다 — 기존 마이그레이션을 적용 완료로 기록합니다"
  for f in "$MIG_DIR"/*.sql; do
    sql "insert into schema_migrations (filename) values (:'fn') on conflict do nothing" \
      -q -v fn="$(basename "$f")"
  done
fi

changed=0
for f in "$MIG_DIR"/*.sql; do
  base=$(basename "$f")
  done_already=$(sql "select count(*) from schema_migrations where filename = :'fn'" -tA -v fn="$base")
  if [ "$done_already" != "0" ]; then continue; fi
  echo "→ $base 적용"
  command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -v app_user_pw="$APP_USER_PASSWORD" -v app_service_pw="$APP_SERVICE_PASSWORD" -f "$f"
  sql "insert into schema_migrations (filename) values (:'fn')" -q -v fn="$base"
  changed=$((changed + 1))
done

if [ -f "$DB_DIR/seed.sql" ]; then
  echo "→ seed.sql 적용(기본 부서·특보 기준·알림 설정)"
  command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$DB_DIR/seed.sql"
fi

if [ "$changed" = "0" ]; then
  echo "스키마가 이미 최신입니다."
else
  echo "마이그레이션 $changed개를 적용했습니다."
fi
