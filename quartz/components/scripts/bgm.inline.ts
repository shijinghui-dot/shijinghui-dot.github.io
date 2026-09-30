/**
 * 背景音乐：首次交互后自动播放，右下角喇叭按钮控制静音/恢复
 * 音频文件：/static/music/bgm.mp3（用户自行放置，缺失时按钮自动隐藏）
 */

const BGM_KEY = "bgm-muted"
const BGM_SRC = "/static/music/bgm.mp3"

function setupBgm() {
  if (document.getElementById("bgm-toggle")) return // 已初始化（元素挂在 html 上，SPA 导航不销毁）

  const muted = localStorage.getItem(BGM_KEY) === "1"

  const audio = document.createElement("audio")
  audio.id = "bgm-audio"
  audio.src = BGM_SRC
  audio.loop = true
  audio.volume = 0.25
  audio.preload = "auto"
  ;(audio as HTMLAudioElement).style.display = "none"

  const btn = document.createElement("button")
  btn.id = "bgm-toggle"
  btn.title = "背景音乐 开/关"
  btn.setAttribute("aria-label", "背景音乐开关")

  const render = () => {
    btn.textContent = audio.paused ? "🔇" : "🔊"
    btn.classList.toggle("muted", audio.paused)
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation()
    if (audio.paused) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  })
  audio.addEventListener("play", () => {
    localStorage.setItem(BGM_KEY, "0")
    render()
  })
  audio.addEventListener("pause", () => {
    localStorage.setItem(BGM_KEY, "1")
    render()
  })
  // 音频文件缺失：隐藏按钮
  audio.addEventListener("error", () => {
    btn.style.display = "none"
  })

  document.documentElement.appendChild(audio)
  document.documentElement.appendChild(btn)
  render()

  if (muted) return // 用户上次选择静音，不再自动播放

  // 浏览器自动播放策略：需要用户先与页面交互
  const events = ["click", "keydown", "touchstart"] as const
  const start = () => {
    audio.play().catch(() => {})
    events.forEach((ev) => document.removeEventListener(ev, start))
  }
  events.forEach((ev) => document.addEventListener(ev, start))
}

document.addEventListener("nav", setupBgm)
document.addEventListener("render", setupBgm)
window.addEventListener("DOMContentLoaded", setupBgm)

export {}
