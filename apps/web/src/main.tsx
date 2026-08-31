import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const root = createRoot(document.getElementById('root')!)

// 원래 이 가드는 "App이 임포트 시점에 supabase 클라이언트를 만든다"는 사정 때문에
// 있었다. VITE_SUPABASE_* 없이 빌드하면 createClient가 그 자리에서 던져 화면이
// 통째로 비었다. lib/supabase.ts를 지운 지금 그 원인은 사라졌다 — 남은 모듈은
// 임포트만으로 던지지 않는다.
//
// 그래도 가드는 남긴다. 막는 대상이 supabase가 아니라 "App 임포트가 실패하는 모든
// 경우"이기 때문이다: 배포가 어긋나 청크를 못 받아 오거나, 어떤 모듈이 나중에
// 최상위에서 던지게 되는 경우다. 그때 이 가드가 없으면 사용자는 흰 화면만 보고
// 원인은 콘솔에만 남는다. 비용은 동적 임포트 하나뿐이다.
import('./App.tsx')
  .then(({ default: App }) => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
  .catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err)
    console.error('앱 초기화 실패', err)
    root.render(
      <div className="boot-error">
        <h1>날씨경영을 불러오지 못했습니다</h1>
        <p>배포 설정에 문제가 있습니다. 관리자에게 아래 내용을 전달해 주세요.</p>
        <code>{detail}</code>
      </div>,
    )
  })
