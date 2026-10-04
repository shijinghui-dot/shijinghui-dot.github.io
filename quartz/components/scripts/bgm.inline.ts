/**
 * 背景音乐：首次交互后自动播放，右下角喇叭按钮控制静音/恢复
 * 曲目列表：构建时由 Static 发射器扫描 quartz/static/music/ 生成 manifest.json，运行时读取。
 * 音频优先走 jsDelivr CDN（GitHub Pages 的音频流在国内又慢又不稳），失败自动回退站点自身。
 */

const BGM_KEY = "bgm-muted"
const MUSIC_DIR = "/static/music"
const CDN_BASE =
  "https://cdn.jsdelivr.net/gh/shijinghui-dot/shijinghui-dot.github.io@main/quartz/static/music"

let names: string[] = []
let index = 0
let stage = 0 // 0 = jsDelivr CDN，1 = 站点自身
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

  const urlFor = (n: string) =>
    (stage === 0 ? CDN_BASE : MUSIC_DIR) + "/" + encodeURIComponent(n)

  const loadIndex = (i: number) => {
    index = i
    audio.src = urlFor(names[index])
  }
  const loadNext = () => loadIndex((index + 1) % names.length)

  audio.addEventListener("ended", () => {
    loadNext()
    audio.play().catch(() => {})
  })
  // 加载失败：CDN 失败先回退站点自身；再失败则该曲目计为失败并跳下一首；全部失败隐藏按钮
  audio.addEventListener("error", () => {
    console.error("[BGM] 音频加载失败:", audio.src, "code:", audio.error?.code, audio.error?.message)
    if (stage === 0) {
      stage = 1
      loadIndex(index)
      tryAutoplay()
      return
    }
    stage = 0 // 下一首仍先尝试 CDN
    failedCount++
    if (failedCount >= names.length) {
      btn.style.display = "none"
      return
    }
    loadNext()
    tryAutoplay()
  })
  audio.addEventListener("play", () => {
    localStorage.setItem(BGM_KEY, "0")
    render()
  })
  // 真正开始出声才算播放成功，重置失败计数（play 事件在数据加载前就会触发）
  audio.addEventListener("playing", () => {
    failedCount = 0
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
      names = [...tracks].sort(() => Math.random() - 0.5) // 随机播放顺序（洗牌）
      if (names.length === 0) {
        btn.style.display = "none"
        return
      }
      playlistReady = true
      loadIndex(0)
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
