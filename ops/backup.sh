#!/bin/sh
# 데이터베이스를 파일 하나로 통째로 저장한다. 매일 새벽에 자동으로 돌린다
# (docs/운영.md의 "자동 백업 걸기" 참고).
#
# 백업 파일은 서버 안이 아니라 서버 밖(다른 디스크·NAS·외장하드)에 두어야 한다.
# 서버가 통째로 죽는 상황이 바로 백업을 꺼내 쓰는 상황이기 때문이다.
#
#   BACKUP_DIR=/backup/weather ./ops/backup.sh
#
# 비밀번호는 이 파일에 적지 않는다 — postgres 컨테이너 안에서 로컬 소켓으로
# 접속하므로 애초에 필요하지 않다.
set -eu

: "${BACKUP_DIR:?BACKUP_DIR를 지정하세요 (예: BACKUP_DIR=/backup/weather ./ops/backup.sh)}"
[ -d "$BACKUP_DIR" ] || { echo "백업 폴더가 없습니다: $BACKUP_DIR" >&2; exit 1; }

# 저장소 루트에서 실행한다 — docker compose가 docker-compose.yml을 찾아야 한다.
cd "$(dirname "$0")/.."

STAMP=$(date +%Y%m%d-%H%M)
OUT="$BACKUP_DIR/weather-${STAMP}.sql.gz"
TMP="$OUT.partial"

# 실패한 덤프가 정상 백업처럼 남으면 복구할 때가 되어서야 그 사실을 안다.
# 임시 이름으로 받아 성공했을 때만 최종 이름으로 옮긴다.
# set -o pipefail은 sh(POSIX)에 없으므로, pg_dump의 실패는 아래 크기 검사로 잡는다.
docker compose exec -T postgres pg_dump -U postgres --clean --if-exists weather | gzip > "$TMP"

# gzip 헤더만 있는 빈 파일은 20바이트 남짓이다. 정상 덤프는 훨씬 크다.
SIZE=$(wc -c < "$TMP" | tr -d ' ')
if [ "$SIZE" -lt 1000 ]; then
  rm -f "$TMP"
  echo "백업이 비어 있습니다(크기 ${SIZE}바이트). 컨테이너가 떠 있는지 확인하세요." >&2
  exit 1
fi
mv "$TMP" "$OUT"

# 30일이 지난 백업은 지운다. 안 지우면 디스크가 차서 어느 날 DB가 멈춘다.
find "$BACKUP_DIR" -name 'weather-*.sql.gz' -mtime +30 -delete

echo "백업 완료: $OUT (${SIZE}바이트)"
