import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import './index.css'
import { App } from './App'

if (import.meta.env.VITE_HENGYUAN_SITES === 'true') {
  const banner = document.createElement('div')
  banner.className = 'hengyuan-site-banner'
  const back = document.createElement('a')
  back.href = '/'
  back.textContent = '← 衡远资本总览'
  const note = document.createElement('span')
  note.textContent = 'Market Agent · 私人研究工作台 · 免费数据可能延迟；AI 服务需配置'
  banner.append(back, note)
  document.body.prepend(banner)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
