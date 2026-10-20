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
  note.textContent = 'Market Agent · 正在检查研究服务…'
  fetch('/api/market-agent/status').then(response => {
    if (!response.ok) throw new Error('研究服务离线')
    return response.json() as Promise<{ referenceAsOf?: string; modelConfigured: boolean; polygonConfigured: boolean }>
  }).then(status => {
    note.textContent = `筛选快照截至 ${status.referenceAsOf ?? '未导入'} · Polygon ${status.polygonConfigured ? '已配置' : '未配置'} · DeepSeek ${status.modelConfigured ? '已配置' : '未配置'}`
  }).catch(() => { note.textContent = '研究服务暂时离线，刷新页面后重试。' })
  banner.append(back, note)
  document.body.prepend(banner)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
