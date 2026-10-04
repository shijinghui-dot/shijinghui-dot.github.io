/**
 * 背景音乐：首次交互后自动播放，右下角喇叭按钮控制静音/恢复
 * 曲目列表：构建时由 Static 发射器扫描 quartz/static/music/ 生成 manifest.json，
 * 此处运行时读取。之后往 music 文件夹里丢音频文件即可，无需改代码。
 */

const BGM_KEY = "bgm-muted"
const MUSIC_DIR = "/static/music"

let playlist: string[] = []
let index = 0
let failedCount = 0
let playlistReady = false
let interacted = false

function setupBgm() {
  if (document.getElementById("bgm-toggle")) return // 已初始化（元素挂在 html 上，SPA 导航不销毁）

  const muted = localStorage.getItem(BGM_KEY) === "1"

  const audio = document.createElement("audio")
  audio.id = "bgm-audio"
  audio.style.display = "none"
  audio.preload = "auto"
  audio.volume = 0.25

  const btn = document.createElement("button")
  btn.id = "bgm-toggle"
  btn.title = "背景音乐 开/关"
  btn.setAttribute("aria-label", "背景音乐开关")

  const render = () => {
    btn.textContent = audio.paused ? "🔇" : "🔊"
    btn.classList.toggle("muted", audio.paused)
  }

  const playNext = () => {
    index = (index + 1) % playlist.length
    audio.src = playlist[index]
    audio.play().catch(() => {})
  }

  audio.addEventListener("ended", playNext)
  // 某个文件损坏/缺失时自动跳下一首；全部失败则隐藏按钮
  audio.addEventListener("error", () => {
    failedCount++
    if (failedCount >= playlist.length) {
      btn.style.display = "none"
      return
    }
    playNext()
  })
  audio.addEventListener("play", () => {
    failedCount = 0
    localStorage.setItem(BGM_KEY, "0")
    render()
  })
  audio.addEventListener("pause", () => {
    localStorage.setItem(BGM_KEY, "1")
    render()
  })

  btn.addEventListener("click", (e) => {
    e.stopPropagation()
    if (audio.paused) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  })

  document.documentElement.appendChild(audio)
  document.documentElement.appendChild(btn)
  render()

  // 静音或歌单未就绪或尚未交互时不自动播放
  const tryAutoplay = () => {
    if (muted || !playlistReady || !interacted) return
    audio.play().catch(() => {})
  }

  // 运行时读取构建时生成的播放列表
  fetch(`${MUSIC_DIR}/manifest.json`)
    .then((res) => res.json())
    .then((tracks: string[]) => {
      playlist = [...tracks].sort(() => Math.random() - 0.5) // 随机播放顺序（洗牌）
      if (playlist.length === 0) {
        btn.style.display = "none"
        return
      }
      playlistReady = true
      audio.src = playlist[0]
      tryAutoplay()
    })
    .catch(() => {
      btn.style.display = "none"
    })

  // 浏览器自动播放策略：需要用户先与页面交互
  const events = ["click", "keydown", "touchstart"] as const
  const onFirstInteraction = () => {
    interacted = true
    events.forEach((ev) => document.removeEventListener(ev, onFirstInteraction))
    tryAutoplay()
  }
  events.forEach((ev) => document.addEventListener(ev, onFirstInteraction))
}

document.addEventListener("nav", setupBgm)
document.addEventListener("render", setupBgm)
window.addEventListener("DOMContentLoaded", setupBgm)

export {}
