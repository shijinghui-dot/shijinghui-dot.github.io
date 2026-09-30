/**
 * TOC scrollspy：滚动正文时高亮右侧目录中当前阅读的章节（飞书风格）
 */
document.addEventListener("nav", setupTocSpy)
document.addEventListener("render", setupTocSpy)
window.addEventListener("DOMContentLoaded", setupTocSpy)

function setupTocSpy() {
  if (window.__tocSpyCleanup) {
    window.__tocSpyCleanup()
    window.__tocSpyCleanup = null
  }

  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>("ul.toc-content a[data-for]"),
  )
  if (links.length === 0) return

  const heads = links
    .map((a) => document.getElementById(a.getAttribute("data-for")!))
    .filter((el): el is HTMLElement => el !== null)
  if (heads.length === 0) return

  const setActive = () => {
    const fromTop = window.scrollY + 80
    let current = heads[0]
    for (const h of heads) {
      if (h.offsetTop <= fromTop) current = h
    }
    // 滚动到页面底部时高亮最后一项
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 4) {
      current = heads[heads.length - 1]
    }
    for (const a of links) {
      a.classList.toggle("toc-active", a.getAttribute("data-for") === current.id)
    }
  }

  let ticking = false
  const onScroll = () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        setActive()
        ticking = false
      })
      ticking = true
    }
  }

  window.addEventListener("scroll", onScroll, { passive: true })
  setActive()
  window.__tocSpyCleanup = () => window.removeEventListener("scroll", onScroll)
}
