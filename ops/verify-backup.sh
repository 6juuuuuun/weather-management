#!/bin/sh
# 백업 파일이 진짜 쓸 수 있는 백업인지 검사한다.
#
#   ./ops/verify-backup.sh /backup/weather/weather-20260901-0300.sql.gz
#
# 왜 따로 있나: 크기가 크다는 것은 백업이 성공했다는 뜻이 아니다. pg_dump가
# 테이블을 알파벳 순으로 쏟아내는 도중에 끊기면(디스크 풀, 커넥션 단절,
# 컨테이너 재시작) 앞쪽 테이블만 담긴 수 MB짜리 파일이 남는다. 실제로
# employees와 departments가 통째로 빠진 9.8MB 파일이 "정상 백업"으로
# 저장된 적이 있다. 그 파일로 복구하면 데이터베이스가 비고 앱이 뜨지 않는다.
#
# 여기서 세 가지를 본다.
#   1) gzip 자체가 온전한가        — 잘린 파일은 gzip -t 에서 걸린다
#   2) pg_dump의 완료 표지가 있는가 — pg_dump는 정상 종료할 때만 파일 끝에
#      "PostgreSQL database dump complete"를 쓴다. 중간에 끊기면 없다
#   3) 꼭 있어야 할 테이블이 담겼는가 — 위 실패는 뒤쪽 테이블부터 사라진다
set -eu

FILE="${1:?검사할 백업 파일 경로를 넘기세요 (예: ./ops/verify-backup.sh /backup/weather/weather-*.sql.gz)}"
[ -f "$FILE" ] || { echo "그런 파일이 없습니다: $FILE" >&2; exit 1; }

fail() { echo "❌ 못 쓰는 백업입니다: $FILE" >&2; echo "   $1" >&2; exit 1; }

# 1) gzip 온전성
gzip -t "$FILE" 2>/dev/null || fail "파일이 손상됐습니다(gzip 검사 실패). 다시 백업하세요."

# 2) 완료 표지. pg_dump는 정상 종료할 때만 이 줄을 마지막에 쓴다.
if ! gunzip -c "$FILE" | tail -20 | grep -q "PostgreSQL database dump complete"; then
  fail "덤프가 중간에 끊겼습니다(완료 표지가 없습니다). 이 파일로 복구하면 데이터가 사라집니다."
fi

# 3) 반드시 들어 있어야 할 테이블. pg_dump는 행이 0개인 테이블도 COPY 절을
#    남기므로, 없다는 것은 거기까지 못 갔다는 뜻이다. 알파벳 순 뒤쪽에 있는
#    것들을 고른다 — 중간에 끊기면 뒤쪽부터 사라진다.
DUMPED=$(gunzip -c "$FILE" | grep '^COPY public\.' || true)
MISSING=""
for t in departments employees weather_criteria weather_observations; do
  echo "$DUMPED" | grep -q "^COPY public\.$t " || MISSING="$MISSING $t"
done
[ -z "$MISSING" ] || fail "테이블이 빠졌습니다:$MISSING"

TABLES=$(echo "$DUMPED" | grep -c '^COPY public\.' || true)
SIZE=$(wc -c < "$FILE" | tr -d ' ')
echo "✅ 쓸 수 있는 백업입니다: $FILE"
echo "   테이블 ${TABLES}개, ${SIZE}바이트"
