# 날씨경영 웹 콘솔

날씨 특보 감지·승인·행동 지침 발송을 관리하는 관리자용 웹 콘솔 (Vite + React + TypeScript + Tailwind v4).

```bash
npm run dev     # http://localhost:5173
npm run build   # 프로덕션 빌드 (tsc -b && vite build)
npx vitest run  # 테스트
```

이 앱에는 환경변수가 없다. Supabase 의존을 걷어내면서 `VITE_*` 값이 전부 사라졌고,
서버와는 같은 오리진의 상대경로(`/api/...`)로만 이야기한다(`src/lib/api/client.ts`).

프로덕션에서는 이 빌드 결과(`dist`)를 Express가 그대로 서빙한다 —
`server/Dockerfile`이 빌드해 `/app/public`에 넣고, `server/src/index.ts`가 정적 서빙과
SPA 폴백을 담당한다. 운영 환경변수는 저장소 루트의 `.env.selfhost.example` 하나뿐이다.

`npm run dev`(5173)로 따로 띄울 때는 API 요청이 5173으로 나가므로,
서버(3000)를 함께 띄우고 vite 프록시를 붙이거나 빌드본으로 확인한다.
