'use strict';

const obsidian = require('obsidian');

const MIN_W = 40;
const MAX_W = 2000;
const STEP = 25;

function clamp(w) {
  return Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
}

function basename(src) {
  try {
    const s = decodeURIComponent(src.split('?')[0].split('#')[0]);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return s.slice(i + 1).toLowerCase();
  } catch (e) {
    return '';
  }
}

// 收集一行里的所有图片嵌入语法（Markdown 链接式 + Wikilink 式）
function findImageTokens(text) {
  const tokens = [];
  const mdRe = /!\[([^\]]*)\]\(([^()\s]+)(?:\s+[^)]*)?\)/g;
  const wlRe = /!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
  let m;
  while ((m = mdRe.exec(text))) {
    tokens.push({ type: 'md', alt: m[1], url: m[2], start: m.index, end: m.index + m[0].length });
  }
  while ((m = wlRe.exec(text))) {
    tokens.push({ type: 'wl', target: m[1], label: m[2], start: m.index, end: m.index + m[0].length });
  }
  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

function tokenName(t) {
  return t.type === 'md' ? basename(t.url) : basename(t.target);
}

// 取尺寸描述：alt/label 的最后一个 | 段，形如 613 或 613x400
function sizeSegment(s) {
  if (!s) return null;
  const i = s.lastIndexOf('|');
  if (i === -1) return null;
  const seg = s.slice(i + 1).trim();
  return /^\d+(x\d+)?$/.test(seg) ? { segStart: i + 1, segEnd: s.length, text: seg } : null;
}

function tokenWidth(t) {
  const seg = sizeSegment(t.type === 'md' ? t.alt : t.label);
  return seg ? parseInt(seg.text, 10) : null;
}

// 计算把宽度改成 newW 时需要的源码替换区间（相对整行的字符位置）
function buildEdit(t, newW) {
  if (t.type === 'md') {
    const altStart = t.start + 2;
    const seg = sizeSegment(t.alt);
    if (seg) {
      const x = seg.text.indexOf('x');
      const text = x >= 0 ? String(newW) + seg.text.slice(x) : String(newW);
      return { from: altStart + seg.segStart, to: altStart + seg.segEnd, text };
    }
    return { from: altStart + t.alt.length, to: altStart + t.alt.length, text: '|' + newW };
  }
  // wikilink：![[target|label]]，label 整体数字 / caption|数字 两种都处理
  const labelStart = t.start + 3 + t.target.length + 1;
  if (t.label != null) {
    let seg = sizeSegment(t.label);
    let sStart;
    let sEnd;
    if (seg) {
      sStart = labelStart + seg.segStart;
      sEnd = labelStart + seg.segEnd;
    } else if (/^\d+(x\d+)?$/.test(t.label.trim())) {
      sStart = labelStart;
      sEnd = labelStart + t.label.length;
    }
    if (sStart != null) {
      const sizeText = t.label.slice(sStart - labelStart, sEnd - labelStart);
      const x = sizeText.indexOf('x');
      const text = x >= 0 ? String(newW) + sizeText.slice(x) : String(newW);
      return { from: sStart, to: sEnd, text };
    }
    return { from: t.end - 2, to: t.end - 2, text: '|' + newW };
  }
  return { from: t.end - 2, to: t.end - 2, text: '|' + newW };
}

// 编辑器中渲染的图片 DOM → 对应的源码行与语法 token
function resolveTarget(plugin, img) {
  const mdView = plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
  if (!mdView || mdView.getMode() !== 'source') return null; // 仅实时预览/源码模式
  if (!mdView.contentEl.contains(img)) return null;
  const editor = mdView.editor;
  const name = basename(img.src);
  if (!name) return null;

  // 通过 CodeMirror 渲染行定位（有折叠时可能不准，后面有兜底）
  let hint = null;
  const content = img.closest('.cm-content');
  const lineEl = img.closest('.cm-line');
  if (content && lineEl) {
    const lines = Array.prototype.filter.call(
      content.children,
      (el) => el.classList && el.classList.contains('cm-line'),
    );
    const idx = lines.indexOf(lineEl);
    if (idx >= 0) hint = idx;
  }

  let hintMatch = null;
  let firstMatch = null;
  for (let l = 0; l < editor.lineCount(); l++) {
    const text = editor.getLine(l);
    if (!text || text.indexOf('![') === -1) continue;
    for (const t of findImageTokens(text)) {
      if (tokenName(t) === name) {
        if (!firstMatch) firstMatch = { line: l, token: t };
        if (hint !== null && l === hint) {
          hintMatch = { line: l, token: t };
          break;
        }
      }
    }
    if (hintMatch) break;
  }
  const target = hintMatch || firstMatch;
  if (!target) return null;
  return { editor, target, img };
}

module.exports = class ImageResizePlugin extends obsidian.Plugin {
  onload() {
    // Alt + 滚轮：缩放并写回源码
    this.registerDomEvent(
      document,
      'wheel',
      (e) => {
        if (!e.altKey) return;
        const img = e.target;
        if (!(img instanceof HTMLImageElement)) return;
        const t = resolveTarget(this, img);
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        const cur = tokenWidth(t.target.token);
        const base = cur || Math.round(img.getBoundingClientRect().width) || 400;
        const dir = e.deltaY < 0 ? 1 : -1;
        const mul = Math.abs(e.deltaY) > 100 ? 2 : 1;
        this.commit(t, clamp(base + dir * STEP * mul));
      },
      { passive: false, capture: true },
    );

    // Alt + 鼠标拖拽：横向拖动实时缩放，松开写回源码
    this.registerDomEvent(
      document,
      'mousedown',
      (e) => {
        if (!e.altKey) return;
        const img = e.target;
        if (!(img instanceof HTMLImageElement)) return;
        const t = resolveTarget(this, img);
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        const startW = Math.round(img.getBoundingClientRect().width) || 400;
        const state = { t, startW, curW: null };
        img.style.cursor = 'ew-resize';
        const onMove = (ev) => {
          const w = clamp(state.startW + (ev.clientX - e.clientX) * 2);
          state.curW = w;
          img.style.width = w + 'px';
          img.style.height = 'auto';
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove, true);
          window.removeEventListener('mouseup', onUp, true);
          img.style.width = '';
          img.style.height = '';
          img.style.cursor = '';
          this.commit(state.t, state.curW || startW);
        };
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      },
      { capture: true },
    );

    this.app.workspace.onLayoutReady(() => {
      new obsidian.Notice(
        '图片调整已启用：编辑器中 Alt+滚轮 或 Alt+拖拽图片即可调整大小',
        5000,
      );
    });
  }

  commit(t, w) {
    const edit = buildEdit(t.target.token, w);
    if (!edit) return;
    t.editor.replaceRange(
      edit.text,
      { line: t.target.line, ch: edit.from },
      { line: t.target.line, ch: edit.to },
    );
  }
};
