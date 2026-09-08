# 1단계: 화면(apps/web)을 빌드한다. vite/tsc 같은 빌드 도구는 여기서만 쓰고
# 결과물 dist만 다음 단계로 넘긴다 — 최종 이미지에 devDependencies가 남지 않는다.
FROM node:22-alpine AS web
WORKDIR /build/apps/web
# package*.json만 먼저 복사한다. 소스만 고친 재빌드에서 npm ci 레이어가 캐시된다.
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web ./
RUN npm run build

# 2단계: 서버. TypeScript를 그대로 싣고 node가 실행 시점에 타입을 벗긴다
# (아래 CMD 참고) — 별도 빌드 산출물이 없어 배포되는 코드가 저장소의 코드와 같다.
FROM node:22-alpine
WORKDIR /app

# 곤지암 리조트에서 돌아가는 시스템이다. alpine 기본 시계는 UTC라 그대로 두면
# 로그 시각과 Date 출력이 전부 9시간 어긋나 장애 대응 때 사람이 헷갈린다.
# 스케줄 자체는 이 값에 기대지 않는다 — jobs/scheduler.ts가 timezone을 직접 준다.
# alpine에는 tzdata가 없어서(=Asia/Seoul을 몰라서) 함께 설치한다.
RUN apk add --no-cache tzdata
ENV TZ=Asia/Seoul

# 베이스 이미지에 남아 있는 OS 패키지 보안 수정을 당겨 온다. node:22-alpine 태그는
# 다시 만들어질 때까지 그때의 alpine 패키지를 그대로 들고 있어서, 그 사이에 나온
# libssl/libcrypto 같은 수정이 빠진 채로 굳는다(trivy가 정확히 그것을 잡는다).
RUN apk upgrade --no-cache

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY --from=web /build/apps/web/dist ./public

ENV NODE_ENV=production WEB_ROOT=/app/public
# 이미지 안에서 굳이 root로 돌 이유가 없다. node:22-alpine에 이미 있는 계정이다.
# **npm을 지운다.** 이 컨테이너는 `node src/index.ts`로 뜨고 npm을 한 번도 부르지
# 않는다(아래 CMD). 그런데 node:22-alpine에는 npm이 통째로 들어 있고, 그 안의
# tar·pacote·sigstore·brace-expansion 같은 패키지가 취약점 스캐너에 그대로 잡힌다 —
# 실제로 trivy 결과 13건 중 11건이 전부 이 npm 번들이었고, **우리 앱 의존성에서
# 나온 것은 0건**이었다. 쓰지도 않는 코드가 만드는 공격면이므로 이미지에서 뺀다.
# 의존성 설치는 위 빌드 단계에서 이미 끝났다.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 3000

# --experimental-strip-types가 아니라 --experimental-transform-types다.
# strip-only 모드는 "지우기만 하면 되는" 타입 문법만 처리한다. src/shared/kakaowork.ts의
#   constructor(private botKey: string, ...)
# 같은 파라미터 프로퍼티는 필드 대입 코드를 "만들어내야" 하므로 지원하지 않고,
# 그 파일을 임포트하는 순간 런타임에 터진다("TypeScript parameter property is not
# supported in strip-only mode"). 이 파일은 발송 경로(jobs/send.ts → jobs/common.ts)를
# 통해 index.ts에서 반드시 로드되므로, strip-only로는 서버가 아예 뜨지 않는다.
# 실제로 node:22-alpine에서 재현하고 이 옵션으로 해결했다. shared/는 원본과
# 바이트 단위로 같아야 해서 코드를 고치는 쪽은 선택지가 아니다.
CMD ["node", "--experimental-transform-types", "src/index.ts"]
