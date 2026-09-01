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

# --- 기존 데이터베이스 채택(adopt) ---
#
# 이 스크립트가 생기기 전에 손으로 마이그레이션을 적용해 둔 데이터베이스를 받아들인다.
# 스키마는 이미 있는데 기록만 비어 있는 상태에서 그냥 진행하면 처음부터 다시
# 적용하려다 "type ... already exists"로 멈춘다.
#
# 예전에는 `employees` 테이블이 있는지 하나만 보고 채택했다. 그러면 **어떤 옛 버전
# 스키마든 "전부 적용 완료"로 기록**된다 — 0002까지만 적용된 데이터베이스가 exit 0,
# 컨테이너 healthy, /api/health/deep 200으로 통과하고 0004~0011은 두 번 다시
# 적용되지 않는다. 앱은 멀쩡해 보이는데 첫 발송에서 dispatches.content 없음으로
# 터진다. 이 프로젝트가 가장 피하려는 "조용히 잘못된 상태"다.
#
# 그래서 아래 BASELINE의 **모든 마이그레이션이 남긴 흔적을 하나씩 확인**하고,
# 하나라도 없으면 채택하지 않고 멈춘다(멈추면 앱도 뜨지 않는다 —
# 반쯤 적용된 스키마로 서비스가 시작되는 것보다 낫다).
#
# BASELINE을 파일 목록(*.sql)이 아니라 고정된 이름 목록으로 둔 이유: 채택은
# "추적이 없던 시절의 데이터베이스를 한 번 받아들이는" 일회성 전환이고, 그
# 시점의 마이그레이션 집합은 이 10개로 고정돼 있다. 나중에 0012를 추가해도
# 그건 BASELINE 밖이라 채택 대상이 아니고, 채택 직후 정상 경로로 적용된다.
BASELINE="0000_auth_bootstrap.sql
0001_schema.sql
0002_rls.sql
0004_dispatch_snapshot.sql
0005_dispatch_repeat_no.sql
0007_approver_from_alert_recipients.sql
0008_selfhost_auth.sql
0009_auth_local.sql
0010_role_login.sql
0011_auth_rls.sql"

# BASELINE 각 파일이 남긴 흔적. 없는 것들의 이름만 돌려준다.
BASELINE_PROBE="select coalesce(string_agg(name, ', ' order by name), '')
from (values
  ('0000_auth_bootstrap.sql', exists (select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth' and p.proname = 'uid')),
  ('0001_schema.sql', to_regclass('public.employees') is not null),
  ('0002_rls.sql', exists (select 1 from pg_policies
     where schemaname = 'public' and tablename = 'employees')),
  ('0004_dispatch_snapshot.sql', exists (select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'dispatches' and column_name = 'content')),
  ('0005_dispatch_repeat_no.sql', to_regclass('public.dispatches_event_repeat_uniq') is not null),
  ('0007_approver_from_alert_recipients.sql', exists (select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'current_emp_is_approver')),
  ('0008_selfhost_auth.sql', exists (select 1 from pg_roles where rolname = 'app_service')),
  ('0009_auth_local.sql', to_regclass('public.auth_accounts') is not null),
  ('0010_role_login.sql', exists (select 1 from pg_roles
     where rolname = 'app_service' and rolcanlogin)),
  ('0011_auth_rls.sql', coalesce((select relrowsecurity from pg_class
     where oid = to_regclass('public.auth_accounts')), false))
) as v(name, present)
where not present"

applied_count=$(sql "select count(*) from schema_migrations" -tA)
has_schema=$(sql "select case when to_regclass('public.employees') is null then 0 else 1 end" -tA)
if [ "$applied_count" = "0" ] && [ "$has_schema" = "1" ]; then
  missing=$(sql "$BASELINE_PROBE" -tA)
  if [ -n "$missing" ]; then
    echo "" >&2
    echo "중단: 이 데이터베이스는 스키마가 있지만 최신이 아닙니다." >&2
    echo "  적용된 흔적이 없는 마이그레이션: $missing" >&2
    echo "" >&2
    echo "  여기서 그대로 진행하면 위 파일들이 '적용 완료'로 잘못 기록되어" >&2
    echo "  앞으로 영원히 적용되지 않습니다. 화면은 뜨지만 발송 같은 기능이" >&2
    echo "  나중에 터집니다. 그래서 멈춥니다." >&2
    echo "" >&2
    echo "  개발 담당자에게 이 메시지를 그대로 전달하세요." >&2
    echo "  (docs/운영.md 7-2 '기존 데이터베이스를 옮겨 왔을 때' 참고)" >&2
    exit 1
  fi
  echo "이미 만들어진 데이터베이스입니다 — 기존 마이그레이션을 적용 완료로 기록합니다"
  echo "$BASELINE" | while read -r base; do
    [ -n "$base" ] || continue
    sql "insert into schema_migrations (filename) values (:'fn') on conflict do nothing" \
      -q -v fn="$base"
  done
  # 기본 데이터(seed)도 이미 들어 있는 데이터베이스다. 다시 적용하면 운영자가
  # 지우거나 이름을 바꾼 부서·기준이 되살아난다.
  sql "insert into schema_migrations (filename) values ('seed.sql') on conflict do nothing" -q
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

# seed도 마이그레이션과 똑같이 "한 번만" 적용한다. 예전에는 up 할 때마다 다시
# 적용했는데, seed는 "손대지 않은 데이터베이스에서는 안 늘어난다"는 뜻의
# idempotent일 뿐 **운영자의 정당한 편집에는 안전하지 않다**. 화면에서 안 쓰는
# 부서를 지우거나 '리조트'를 '리조트본부'로 바꿔 두면, 다음 업데이트에서 지운
# 부서가 되살아나고 유령 트리가 새로 생긴다(부서 19 → 24로 늘어나는 것을 확인했다).
# 그 부서 앞으로 알림이 다시 나가기 시작한다는 뜻이라 그냥 두면 안 된다.
#
# 기본 데이터의 내용을 바꿔야 한다면 seed.sql을 고치는 것이 아니라 새 마이그레이션
# 파일을 더한다 — 마이그레이션과 완전히 같은 규칙이다.
if [ -f "$DB_DIR/seed.sql" ]; then
  seed_done=$(sql "select count(*) from schema_migrations where filename = 'seed.sql'" -tA)

  # seed 기록을 붙이기 전 버전으로 설치된 곳: 추적 표에는 이미 마이그레이션이
  # 기록돼 있는데(applied_count > 0) seed 기록만 없다. 기본 데이터는 그때 이미
  # 들어갔으므로 다시 적용하지 않고 기록만 남긴다 — 다시 적용하면 그동안
  # 운영자가 지우거나 이름을 바꾼 부서가 마지막으로 한 번 되살아난다.
  # (applied_count는 이 실행에서 마이그레이션을 적용하기 "전"의 값이다.
  #  새로 설치하는 경우에는 0이므로 이 분기에 걸리지 않고 아래에서 정상 적용된다.)
  if [ "$seed_done" = "0" ] && [ "$applied_count" != "0" ]; then
    sql "insert into schema_migrations (filename) values ('seed.sql') on conflict do nothing" -q
    seed_done=1
    echo "기본 데이터(seed)는 이미 적용된 것으로 기록합니다."
  fi

  if [ "$seed_done" = "0" ]; then
    echo "→ seed.sql 적용(기본 부서·특보 기준·알림 설정)"
    command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$DB_DIR/seed.sql"
    sql "insert into schema_migrations (filename) values ('seed.sql')" -q
  else
    echo "기본 데이터(seed)는 첫 설치 때 이미 들어갔습니다 — 건너뜁니다."
  fi
fi

if [ "$changed" = "0" ]; then
  echo "스키마가 이미 최신입니다."
else
  echo "마이그레이션 $changed개를 적용했습니다."
fi
