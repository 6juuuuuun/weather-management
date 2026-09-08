#!/bin/sh
# 백업 파일로 데이터베이스를 되돌린다. 복구는 실제로 해봐야 백업이다.
#
#   ./ops/restore.sh /backup/weather/weather-20260901-0300.sql.gz
#
# 지금 들어 있는 데이터는 전부 사라지고 백업 시점으로 돌아간다.
set -eu

FILE="${1:?복구할 파일 경로를 넘기세요 (예: ./ops/restore.sh /backup/weather/weather-20260901-0300.sql.gz)}"
[ -f "$FILE" ] || { echo "그런 파일이 없습니다: $FILE" >&2; exit 1; }

cd "$(dirname "$0")/.."
. "$(dirname "$0")/_crypt.sh"

# 덮어쓰기 전에 백업 파일부터 검사한다. 중간에 끊긴 덤프로 복구하면
# 데이터베이스가 비고 앱이 뜨지 않는데, 그때는 되돌릴 원본이 이미 없다.
echo "백업 파일을 검사합니다..."
./ops/verify-backup.sh "$FILE"

echo
echo "경고: 현재 데이터를 모두 덮어씁니다."
echo "  복구할 파일: $FILE"
echo "취소하려면 지금 Ctrl+C를 누르세요. 5초 후 시작합니다."
sleep 5

# 앱이 붙어 있는 채로 스키마를 갈아엎으면 진행 중인 요청이 반쯤 적용된
# 상태를 본다. 복구 동안에는 앱을 내려 둔다.
echo "앱을 잠시 멈춥니다..."
docker compose stop app >/dev/null 2>&1 || true

echo "복구 중..."
# -o /dev/null: 덤프 안의 set_config/setval 결과 표가 화면을 가득 채우는 것을 막는다.
# 오류는 표준오류로 나오므로 그대로 보인다.
crypt_stream "$FILE" | gunzip -c | docker compose exec -T postgres psql -U postgres -d weather -v ON_ERROR_STOP=1 -q -o /dev/null

echo "앱을 다시 띄웁니다..."
docker compose start app >/dev/null

# 확인 명령에 실제 포트를 넣는다. .env에 APP_HOST_PORT를 적어 8080이 아닌
# 곳에서 서비스하는 경우가 있어(docs/운영.md 7-1) 고정으로 8080을 찍으면
# 운영자가 "복구했는데 응답이 없다"고 오해한다.
# 숫자만 뽑는다. cut -d= -f2는 `APP_HOST_PORT=8090   # 설명` 처럼 인라인 주석이
# 붙은 줄에서 주석까지 함께 가져와, 그대로 붙여 넣을 수 없는 안내가 나갔다.
PORT=$(sed -n 's/^APP_HOST_PORT=\([0-9][0-9]*\).*/\1/p' .env 2>/dev/null | tail -1 || true)
[ -n "${PORT:-}" ] || PORT=8080

echo "복구 완료. 잠시 뒤 아래 명령으로 상태를 확인하세요."
echo "  curl -s localhost:$PORT/api/health/deep"
