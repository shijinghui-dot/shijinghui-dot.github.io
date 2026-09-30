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
    let activeLink: HTMLAnchorElement | undefined
    for (const a of links) {
      const isCurrent = a.getAttribute("data-for") === current.id
      a.classList.toggle("toc-active", isCurrent)
      if (isCurrent) activeLink = a
    }
    if (activeLink) centerTocItem(activeLink)
  }

  /** 目录过长时，把当前高亮项滚动到目录面板可视范围（居中） */
  function centerTocItem(link: HTMLAnchorElement) {
    // 向上找到实际可滚动的目录容器
    let scroller: HTMLElement | null = link.parentElement as HTMLElement | null
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) {
      scroller = scroller.parentElement
      if (!scroller || scroller === document.body) return
    }
    if (!scroller) return

    const cr = scroller.getBoundingClientRect()
    const ar = link.getBoundingClientRect()
    // 已完全在可视范围内则不滚动，避免抖动
    if (ar.top >= cr.top && ar.bottom <= cr.bottom) return

    const target =
      scroller.scrollTop + (ar.top - cr.top) - cr.height / 2 + ar.height / 2
    scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" })
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
