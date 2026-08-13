import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const root = createRoot(document.getElementById('root')!)

// App은 supabase 클라이언트를 임포트 시점에 생성한다. 환경변수가 빠진 빌드가
// 배포되면 그 임포트가 던지면서 화면이 완전히 비어버리므로(원인은 콘솔에만 남음),
// 동적 임포트로 감싸 실패 시 원인을 화면에 띄운다.
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
