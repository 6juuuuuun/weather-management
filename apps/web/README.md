# 날씨경영 웹 콘솔

날씨 특보 감지·승인·행동 지침 발송을 관리하는 관리자용 웹 콘솔 (Vite + React + TypeScript + Tailwind v4).

```bash
npm run dev     # http://localhost:5173
npm run build   # 프로덕션 빌드 (tsc -b && vite build)
npx vitest run  # 테스트
```

로컬 개발 전 `.env.example`을 `.env`로 복사하고 `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`를 채워 넣는다.
