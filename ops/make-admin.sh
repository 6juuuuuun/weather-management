#!/bin/sh
# 첫 관리자를 지정한다.
#
# 처음 설치한 데이터베이스에는 관리자가 한 명도 없다. 가입하면 누구나
# 실무자(staff)로 시작하고, 역할을 올려 줄 수 있는 사람은 관리자뿐이라
# 그대로 두면 아무도 아무것도 설정할 수 없다. 그 매듭을 여기서 한 번 푼다.
#
#   1) 웹 화면에서 회사 이메일로 먼저 가입한다
#   2) ./ops/make-admin.sh 본인이메일@gonjiam.com
#   3) 로그아웃했다가 다시 로그인한다
set -eu

EMAIL="${1:?이메일을 넘기세요 (예: ./ops/make-admin.sh hong@gonjiam.com)}"

cd "$(dirname "$0")/.."

# 이 스크립트는 관리자 0명 상태를 푸는 **유일한** 절차다. 막히면 제품 안에 탈출구가
# 없으므로, 막히는 이유를 도커 원문("service \"postgres\" is not running") 대신
# 사람 말로 알려 준다. 실제로 QA에서 이렇게 막혔다: 스택을 `-p weatherqa1`처럼 다른
# 프로젝트 이름으로 올리면 `docker compose exec`가 서비스를 찾지 못하는데, 나오는
# 문장이 "그런 직원이 없습니다"도 아니라 처음 설치하는 사람은 **가입이 잘못된 줄 알고
# 가입을 계속 다시 한다**(QA W-23g).
if [ -z "$(docker compose ps -q postgres 2>/dev/null)" ]; then
  echo "이 디렉터리의 compose 프로젝트에서 데이터베이스(postgres) 컨테이너를 찾지 못했습니다." >&2
  echo "" >&2
  echo "1) 스택이 떠 있는지 보세요:  docker compose ps" >&2
  echo "2) 다른 프로젝트 이름으로 올렸다면(-p 또는 COMPOSE_PROJECT_NAME) 같은 이름을 주고 실행하세요:" >&2
  echo "     COMPOSE_PROJECT_NAME=<프로젝트이름> ./ops/make-admin.sh $EMAIL" >&2
  echo "   떠 있는 프로젝트 이름은 'docker compose ls'로 볼 수 있습니다." >&2
  exit 1
fi

# 이메일은 psql의 -v로 넘겨 :'변수'로 꽂는다 — 문자열을 이어 붙이지 않는다.
# 주의: psql -c로 준 문장은 변수 치환을 거치지 않고 서버로 그대로 간다
# (`syntax error at or near ":"`). 문장을 표준입력으로 흘려 -f - 로 읽혀야 한다.
OUT=$(printf '%s\n' "update employees set role = 'admin' where lower(email) = lower(:'email') returning email" \
  | docker compose exec -T postgres psql -U postgres -d weather -v ON_ERROR_STOP=1 -tAq \
      -v email="$EMAIL" -f -)

if [ -z "$OUT" ]; then
  echo "그런 직원이 없습니다: $EMAIL" >&2
  echo "웹 화면에서 먼저 가입한 뒤 다시 실행하세요. 가입한 이메일과 철자가 같아야 합니다." >&2
  exit 1
fi

echo "관리자로 지정했습니다: $OUT"
echo "웹 화면에서 로그아웃했다가 다시 로그인하면 관리자 메뉴가 보입니다."
