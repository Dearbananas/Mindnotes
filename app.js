/* =========================================================================
 * MindNotes — 自研 Vanilla JS 思维导图笔记
 * 节点 = HTML，可内嵌文字/图片/表格；左→右树状布局；折叠/平移/缩放；
 * 数据走 GitHub Contents API（未配置时退回 localStorage）。
 * 无任何外部 CDN / 第三方库依赖。
 * ========================================================================= */

/* ---------------- 全局状态 ---------------- */
const APP = {
  owner: '', repo: '', branch: 'main', token: '',
  notesFolder: 'notes', assets: 'assets'
};
let currentUser = null;   // 当前登录账号，未登录时为 null
let root = null;
let selectedId = null;
let scale = 1, tx = 60, ty = 60;
let panning = false, panStart = null;

const V_GAP = 22;   // 同级节点垂直间距
const H_GAP = 64;   // 父子节点水平间距

const viewport = document.getElementById('viewport');
const canvas = document.getElementById('canvas');
const nodesLayer = document.getElementById('nodes');
const edgesSvg = document.getElementById('edges');
const fileInput = document.getElementById('fileInput');

/* ---------------- 工具函数 ---------------- */
const newId = () => 'n' + Math.random().toString(36).slice(2, 9);
const newNode = (content = '') => ({ id: newId(), content, collapsed: false, children: [] });

function findNode(n, id) {
  if (n.id === id) return n;
  for (const c of n.children) { const r = findNode(c, id); if (r) return r; }
  return null;
}
function findParent(n, id, parent = null) {
  if (n.id === id) return parent;
  for (const c of n.children) { const r = findParent(c, id, n); if (r !== undefined) return r; }
  return undefined;
}
function collect(n, arr = []) { arr.push(n); for (const c of n.children) collect(c, arr); return arr; }

function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob((b64 || '').replace(/\s+/g, '')))); }

function toast(msg, ms = 1800) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------------- 渲染 ---------------- */
function render() {
  nodesLayer.innerHTML = '';
  edgesSvg.innerHTML = '';
  if (typeof hideImgHandle === 'function') hideImgHandle();
  const all = collect(root);

  for (const n of all) {
    const el = document.createElement('div');
    el.className = 'node' + (n.collapsed ? ' collapsed' : '') + (n.id === selectedId ? ' selected' : '');
    el.dataset.id = n.id;

    /* 可编辑文字单独放进 .node-content，grip/toggle 作为 .node 的兄弟浮控件。
       否则当文字被清空、.node 内容只剩不可编辑的把手时，Chromium 找不到插入点，
       导致"删空后无法再输入"——这是 contenteditable 的经典坑。 */
    const content = document.createElement('div');
    content.className = 'node-content';
    content.contentEditable = 'true';
    content.dataset.id = n.id;
    content.innerHTML = n.content || '';
    el.appendChild(content);
    n._el = el; n._content = content;
    /* 把 [[节点名]] 形式的文本转换成可点击的内部链接锚点（不修改 n.content；DOM 上呈现即可） */
    convertInnerLinksInEl(content);
    applyNodeStyle(el, n);

    // 折叠按钮（仅当有子节点）
    if (n.children.length) {
      const tg = document.createElement('div');
      tg.className = 'toggle';
      tg.contentEditable = 'false';
      tg.textContent = n.collapsed ? '+' : '−';
      tg.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        n.collapsed = !n.collapsed;
        render();
      });
      el.appendChild(tg);
    }

    // 拖拽把手（根节点不可拖动）
    if (n !== root) {
      const g = document.createElement('div');
      g.className = 'grip';
      g.contentEditable = 'false';
      g.textContent = '⠿';
      g.title = '拖到其他节点上，可改变层级';
      g.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); startDrag(n.id, e); });
      el.appendChild(g);
    }

    // 节点尺寸调整手柄（右下角 · 改宽度/高度）—— 任意节点都能调
    {
      const rh = document.createElement('div');
      rh.className = 'resize-handle';
      rh.contentEditable = 'false';
      rh.title = '拖动调整节点尺寸（Ctrl = 只改高 / Shift = 只改宽）';
      rh.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); startNodeResize(n.id, e); });
      el.appendChild(rh);
    }

    /* mousedown 只标记选中、阻止画布平移；光标交给浏览器原生处理（点在哪光标就在哪）。
       若传 focus=true 会强制把光标移到末尾，导致无法在文字中间编辑/拖选。
       额外显式 focus 一道：兼容个别浏览器在可编辑元素上不自动聚焦的边缘情况。 */
    content.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'IMG') { e.stopPropagation(); return; }   // 图片走放大查看器
      e.stopPropagation();
      if (drag) cancelDrag();
      const editing = document.activeElement === content;
      pending = { id: n.id, x: e.clientX, y: e.clientY, editing };
      if (!editing) e.preventDefault();   // 非编辑态先不聚焦（便于判定拖拽）；编辑态保留选词能力
    });
    content.addEventListener('focus', () => selectNode(n.id, false));
    content.addEventListener('blur', () => { n.content = serializeNode(el); autosave(); typing = false; });
    nodesLayer.appendChild(el);
  }

  layout();
  drawEdges();
  applyTransform();
}

/* 取节点内容：从 .node 里取出 .node-content 的真实 innerHTML（剔掉折叠按钮/把手等 UI 控件）。
   注意：必须返回「.node-content 内部」的 HTML，而不是整个 .node 的 innerHTML——
   否则 n.content 会带上 <div class="node-content"> 外壳，下次 render 时又把外壳塞进
   新的 .node-content，形成层层嵌套（编辑即变形）。 */
function serializeNode(el) {
  const c = (el.classList && el.classList.contains('node-content')) ? el : el.querySelector('.node-content');
  return c ? c.innerHTML : '';
}

/* ---------------- 复制节点内容 ---------------- */
/* 复制：优先写入「富文本 HTML + 纯文本」两种格式（粘到 MindNotes/富编辑器保留表格图片，
   粘到记事本等纯文本环境自动降级为文字）。file:// 等非安全上下文没有 Clipboard API 时，
   用隐藏 textarea + execCommand 兜底。返回是否成功。 */
async function copyToClipboard(html, text) {
  if (navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text || ''], { type: 'text/plain' })
      })]);
      return true;
    } catch (e) { /* 落到下面的兜底 */ }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text || ''); return true; } catch (e) {}
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text || '';
    ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
/* 复制当前选中节点的内容（取其 .node-content 的实时 HTML/文本，含未失焦的最新输入） */
function copySelectedNodeContent() {
  if (!selectedId) { toast('先选中一个节点'); return; }
  const n = findNode(root, selectedId);
  if (!n || !n._el) { toast('没有可复制的节点'); return; }
  const c = n._el.querySelector('.node-content');
  const html = c ? c.innerHTML : (n.content || '');
  const text = c ? c.textContent : '';
  copyToClipboard(html, text)
    .then(ok => toast(ok ? '已复制节点内容 ✓' : '复制失败（浏览器限制）'))
    .catch(() => toast('复制失败（浏览器限制）'));
}
/* 仅复制纯文本（去掉所有 HTML 标签） */
function copyNodePlain() {
  if (!selectedId) { toast('先选中一个节点'); return; }
  const n = findNode(root, selectedId);
  if (!n || !n._el) { toast('没有可复制的节点'); return; }
  const c = n._el.querySelector('.node-content');
  const text = c ? c.textContent : (n.content || '');
  copyToClipboard(text, text)
    .then(ok => toast(ok ? '已复制为纯文本 ✓' : '复制失败（浏览器限制）'))
    .catch(() => toast('复制失败（浏览器限制）'));
}
/* 复制整棵子树为缩进大纲（2 空格一级），可直接粘进「导入 → 粘贴大纲文本」重建分支 */
function copyNodeSubtreeOutline() {
  if (!selectedId) { toast('先选中一个节点'); return; }
  const n = findNode(root, selectedId);
  if (!n) { toast('没有可复制的节点'); return; }
  const strip = (html) => (html || '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() || '（空节点）';
  const lines = [];
  const walk = (node, depth) => {
    lines.push('  '.repeat(depth) + strip(node.content));
    for (const c of (node.children || [])) walk(c, depth + 1);
  };
  walk(n, 0);
  const text = lines.join('\n');
  copyToClipboard(text, text)
    .then(ok => toast(ok ? '已复制子树大纲 ✓' : '复制失败（浏览器限制）'))
    .catch(() => toast('复制失败（浏览器限制）'));
}
/* ---------------- 复制 / 粘贴整棵分支（内部剪贴板） ---------------- */
/* 不走系统剪贴板，避免 file:// 下 Clipboard API 权限问题；保留样式与图片，比「大纲」更完整 */
let nodeClipboard = null;
function cloneBranch(n) {
  return {
    id: newId(),
    content: n.content || '',
    collapsed: false,
    style: n.style ? Object.assign({}, n.style) : undefined,
    children: (n.children || []).map(cloneBranch)
  };
}
function copyBranch() {
  if (!selectedId) { toast('先选中一个节点'); return; }
  const n = findNode(root, selectedId);
  if (!n) { toast('没有可复制的节点'); return; }
  nodeClipboard = cloneBranch(n);
  toast('已复制分支（含子节点）到内部剪贴板 ✓');
}
function pasteBranch() {
  if (!selectedId) { toast('先选中一个节点'); return; }
  if (!nodeClipboard) { toast('内部剪贴板为空：先「复制分支」'); return; }
  const p = findNode(root, selectedId);
  if (!p) return;
  p.collapsed = false;
  const clone = cloneBranch(nodeClipboard);     // 再克隆一次，保证每次粘贴 id 都新
  p.children.push(clone);
  render(); selectNode(clone.id); autosave();
}

/* 打字时防抖落账：让 Ctrl+Z 能退回到「上一次停顿」，而不是退回到上一次失焦 */
let typeTimer = null;
nodesLayer.addEventListener('input', (e) => {
  typing = true;
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => { syncEditingNode(); autosave(); }, 900);
  /* 用户敲完「]]」时把 [[name]] 文本节点就地换成 <a> 锚点（不打断光标、不触发 render） */
  if (e.target && e.target.classList && e.target.classList.contains('node-content')) {
    convertInnerLinksInEl(e.target);
  }
});
/* 点击 .inner-link 锚点 → 跳转（事件委托） */
nodesLayer.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.inner-link');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  jumpToInnerLink(a.dataset.name);
});

/* 把节点保存的样式对象套用到 DOM */
function applyNodeStyle(el, n) {
  const s = n.style || {};
  el.style.fontSize   = s.fontSize ? s.fontSize + 'px' : '';
  el.style.fontWeight = s.bold   ? '700' : '';
  el.style.fontStyle  = s.italic ? 'italic' : '';
  el.style.color      = s.color  || '';
  el.style.background = s.bg     || '';
  el.style.borderColor= s.border || '';
  /* 尺寸：minW 是用户拖宽的"最小宽度"（=节点的"自定义宽度"），maxW 兜底防止内容撑到太宽。
     minH 是"自定义高度"（拖高时设），节点默认高度由内容决定。 */
  el.style.minWidth  = s.minW ? s.minW + 'px' : '';
  el.style.maxWidth  = s.maxW ? s.maxW + 'px' : '';
  el.style.minHeight = s.minH ? s.minH + 'px' : '';
  el.style.height    = s.minH ? s.minH + 'px' : '';   // 设了 minH 就锁高（用户主动锁的，不让内容撑开）
  el.classList.toggle('highlight', !!s.highlight);
  el.classList.toggle('sized',    !!(s.minW || s.minH || s.maxW));
}

/* 左→右树形布局：先量节点尺寸，再递归定位 */
function layout() {
  const all = collect(root);

  /* 先全部显示并量尺寸（隐藏的元素量不出来） */
  for (const n of all) { n._el.style.display = ''; n._hidden = false; }
  for (const n of all) { n.w = n._el.offsetWidth; n.h = n._el.offsetHeight; }

  /* 折叠节点的子孙：标记隐藏并移出渲染流。
     否则它们会以未定位状态（x/y 为 undefined）堆在画布左上角。 */
  const markHidden = (n) => { for (const c of n.children) { c._hidden = true; markHidden(c); } };
  for (const n of all) if (n.collapsed) markHidden(n);
  for (const n of all) if (n._hidden) n._el.style.display = 'none';

  const subH = (n) => {
    if (n.collapsed || !n.children.length) return n.h;
    let s = 0;
    for (const c of n.children) s += subH(c) + V_GAP;
    return Math.max(n.h, s - V_GAP);
  };
  const assign = (n, x, yTop) => {
    n.x = x;
    const sh = subH(n);
    n.y = yTop + (sh - n.h) / 2;
    if (!n.collapsed && n.children.length) {
      const cx = x + n.w + H_GAP;
      let cy = yTop;
      for (const c of n.children) { const ch = subH(c); assign(c, cx, cy); cy += ch + V_GAP; }
    }
  };
  assign(root, 0, 0);

  let maxX = 0, maxY = 0;
  for (const n of all) {
    if (n._hidden) continue;                 // 隐藏节点没有有效坐标，跳过
    n._el.style.left = n.x + 'px';
    n._el.style.top = n.y + 'px';
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  canvas.style.width = (maxX + 200) + 'px';
  canvas.style.height = (maxY + 200) + 'px';
  edgesSvg.setAttribute('width', maxX + 200);
  edgesSvg.setAttribute('height', maxY + 200);
}

function drawEdges() {
  const all = collect(root);
  let svg = '';
  for (const n of all) {
    if (n.collapsed) continue;
    for (const c of n.children) {
      const x1 = n.x + n.w, y1 = n.y + n.h / 2;
      const x2 = c.x, y2 = c.y + c.h / 2;
      const mx = (x1 + x2) / 2;
      svg += `<path class="edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
    }
  }
  edgesSvg.innerHTML = svg;
}

function applyTransform() {
  canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  if (typeof positionImgHandle === 'function') positionImgHandle();
}

function selectNode(id, focus = true) {
  selectedId = id;
  for (const el of nodesLayer.children) el.classList.toggle('selected', el.dataset.id === id);
  if (!stylePanel.classList.contains('hidden')) syncStylePanel();
  if (focus) {
    const n = findNode(root, id);
    if (n && n._el) { const c = n._el.querySelector('.node-content'); if (c) { c.focus(); placeCaretEnd(c); } }
  }
}
function placeCaretEnd(contentEl) {
  const r = document.createRange();
  r.selectNodeContents(contentEl); r.collapse(false);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}

/* ---------------- 节点内跳转（[[节点名]] 内部链接） ---------------- */
/* 把 el 内的 [[name]] 文本节点转换成 <a class="inner-link" data-name="name">name</a> 锚点。
   不改 n.content；只是 DOM 层呈现。点击时由 nodesLayer 上的事件委托负责跳转。 */
const INNER_LINK_RE = /\[\[([^\[\]\n]{1,80}?)\]\]/g;
function convertInnerLinksInEl(el) {
  if (!el || typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && INNER_LINK_RE.test(n.nodeValue)) textNodes.push(n);
    INNER_LINK_RE.lastIndex = 0;
  }
  for (const tn of textNodes) {
    const val = tn.nodeValue;
    INNER_LINK_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = INNER_LINK_RE.exec(val)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(val.slice(last, m.index)));
      const a = document.createElement('a');
      a.className = 'inner-link';
      a.dataset.name = m[1];
      a.textContent = m[1];
      a.setAttribute('contenteditable', 'false');
      a.title = '跳转到「' + m[1] + '」';
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < val.length) frag.appendChild(document.createTextNode(val.slice(last)));
    tn.parentNode && tn.parentNode.replaceChild(frag, tn);
  }
}
/* 按节点纯文本的「首行」匹配（content 第一行就是用户在脑图里看到的「节点名」；
   <br>/</p>/</div> 视为行分隔，剥标签、剥空白；最多 80 字） */
function nodeMatchText(n) {
  const raw = n.content || '';
  const stopMatch = raw.match(/<br\s*\/?>|<\/p>|<\/div>/i);
  const firstLine = stopMatch ? raw.slice(0, stopMatch.index) : raw;
  return stripTags(firstLine).trim().slice(0, 80);
}
function findNodeByName(rootN, name) {
  if (!rootN || !name) return null;
  const all = collect(rootN);
  return all.find(n => nodeMatchText(n) === name) || null;
}
function findNodeByNameAcrossNotes(name, exceptNoteId) {
  for (const id of noteOrder) {
    if (id === exceptNoteId) continue;
    const note = notes[id]; if (!note || !note.root) continue;
    const m = findNodeByName(note.root, name);
    if (m) return { node: m, noteId: id, noteTitle: note.title };
  }
  return null;
}
async function jumpToInnerLink(name) {
  if (!name) return;
  let target = findNodeByName(root, name);
  let fromNote = currentNoteId;
  if (!target) {
    const cross = findNodeByNameAcrossNotes(name, currentNoteId);
    if (cross) { target = cross.node; fromNote = cross.noteId; toast('已跳到笔记「' + cross.noteTitle + '」'); }
  }
  if (!target) { toast('找不到节点：' + name); return; }
  if (fromNote !== currentNoteId) await switchNote(fromNote);
  /* 展开所有祖先 */
  for (const a of findAncestors(fromNote, target.id)) a.collapsed = false;
  render(); fitView();
  selectNode(target.id);
  /* 把节点居中 */
  const el = target._el;
  if (el) {
    const r2 = el.getBoundingClientRect();
    const vw = viewport.getBoundingClientRect();
    tx += r2.left - vw.left - vw.width / 2 + r2.width / 2;
    ty += r2.top - vw.top - vw.height / 2 + r2.height / 2;
    applyTransform();
  }
}

/* ---------------- Ctrl+V 粘贴剪贴板图片 ---------------- */
/* 监听全局 paste 事件：如果剪贴板里有图片（截图、复制图片文件等），自动作为图片插入到当前选中节点。
   没有图片时，交给浏览器默认行为（contenteditable 里粘贴文字） */
function blobToFile(blob, nameHint) {
  const ext = (blob.type && blob.type.split('/')[1]) || 'png';
  const name = `${nameHint || 'img'}_${Date.now()}.${ext}`;
  return new File([blob], name, { type: blob.type || 'image/png' });
}
function handlePasteImage(e) {
  if (!selectedId) return false;                                // 未选中节点 → 交给默认
  if (!e.clipboardData) return false;
  const items = e.clipboardData.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
      e.preventDefault();
      const blob = it.getAsFile();
      if (!blob) return true;
      insertImageFromFile(blobToFile(blob, 'pasted'));
      return true;
    }
  }
  return false;                                                  // 没有图片 → 默认行为（文字粘贴）
}
document.addEventListener('paste', (e) => {
  /* 输入框里不接管（token/设置里需要原生粘贴） */
  const tag = (e.target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  /* 节点编辑态：只在剪贴板含图片时拦截，纯文字粘贴交给 contenteditable */
  if (e.target.classList && e.target.classList.contains('node-content')) {
    handlePasteImage(e);
    return;
  }
  /* 未编辑态（如选中节点但没进 contenteditable）：只在有图片时插入 */
  if (handlePasteImage(e)) return;
});

/* ---------------- 节点操作 ---------------- */
function addChild() {
  if (!selectedId) { toast('先选中一个节点'); return; }
  const p = findNode(root, selectedId);
  if (!p) return;
  p.collapsed = false;
  const child = newNode('新节点');
  p.children.push(child);
  render(); selectNode(child.id); autosave();
}
function addSibling() {
  if (!selectedId) { toast('先选中一个节点'); return; }
  const parent = findParent(root, selectedId);
  if (parent === null) { toast('根节点不能加同级'); return; }
  const idx = parent.children.findIndex(c => c.id === selectedId);
  const sib = newNode('新节点');
  parent.children.splice(idx + 1, 0, sib);
  render(); selectNode(sib.id); autosave();
}
/* Enter 快捷键：新增同级节点（根节点无同级 → 回退为新增子节点） */
function addEnterNode() {
  if (!selectedId) return;
  syncEditingNode();                 // 先保存当前节点已输入的内容
  const parent = findParent(root, selectedId);
  if (parent === null) addChild();   // 根节点：Enter 加子节点
  else addSibling();
}
/* Tab+Shift：节点升一级（成为父节点的同级，插在父节点之后；父为根节点则不可升） */
function promoteNode() {
  if (!selectedId) { toast('先选中一个节点'); return; }
  syncEditingNode();
  const parent = findParent(root, selectedId);
  if (parent === null) { toast('已在顶层，无法升级'); return; }
  const grand = findParent(root, parent.id);
  if (grand === null) { toast('已在顶层，无法升级'); return; }   // 父节点就是根节点
  const idxP = grand.children.findIndex(c => c.id === parent.id);
  const idx = parent.children.findIndex(c => c.id === selectedId);
  const [node] = parent.children.splice(idx, 1);
  grand.children.splice(idxP + 1, 0, node);
  render(); selectNode(node.id); autosave();
}
function deleteNode() {
  if (!selectedId) return;
  const parent = findParent(root, selectedId);
  if (parent === null) { toast('根节点不能删'); return; }
  if (!confirm('确定删除该节点及其所有子节点？')) return;
  parent.children = parent.children.filter(c => c.id !== selectedId);
  selectedId = null;
  render(); autosave();
}

/* ---------------- 图文表插入 ---------------- */
function insertTable() {
  if (!selectedId) { toast('先选中节点'); return; }
  const n = findNode(root, selectedId);
  const c = n._el.querySelector('.node-content'); c.focus(); placeCaretEnd(c);
  const html = '<table class="ntab"><tr><td>标题</td><td>说明</td></tr>' +
               '<tr><td>要点</td><td>内容</td></tr></table><br>';
  document.execCommand('insertHTML', false, html);
  n.content = serializeNode(n._el); autosave();
}
function insertImageFromFile(file) {
  if (!selectedId) { toast('先选中节点'); return; }
  const n = findNode(root, selectedId);
    const done = (url) => {
    const c = n._el.querySelector('.node-content'); c.focus(); placeCaretEnd(c);
    document.execCommand('insertHTML', false, `<img src="${url}" alt=""><br>`);
    n.content = serializeNode(n._el); autosave();
  };
  if (APP.token && APP.owner && APP.repo) {
    cloudUploadImage(file).then(done).catch(err => {
      toast('上传失败，改用本地嵌入：' + err.message);
      const r = new FileReader(); r.onload = () => done(r.result); r.readAsDataURL(file);
    });
  } else {
    const r = new FileReader(); r.onload = () => done(r.result); r.readAsDataURL(file);
  }
}

/* fetch 包装：超时 + 指数退避重试（适配国内不稳定的网络，GitHub/Gitee 共用） */
async function fetchWithRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < tries) await new Promise(r => setTimeout(r, 700 * i));
    }
  }
  throw lastErr || new Error('网络请求失败');
}

/* ---------------- 云端 Provider 抽象层（GitHub / Gitee 可切换） ---------------- */
function providerLabel() { return APP.provider === 'gitee' ? 'Gitee' : 'GitHub'; }

/* —— GitHub 实现 —— */
async function ghFetch(path) {
  const url = `https://api.github.com/repos/${APP.owner}/${APP.repo}/contents/${encodeURIComponent(path)}?ref=${APP.branch}`;
  const res = await fetchWithRetry(url, {
    headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + APP.token }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function ghPut(path, contentB64, sha) {
  const url = `https://api.github.com/repos/${APP.owner}/${APP.repo}/contents/${encodeURIComponent(path)}`;
  const body = { message: 'MindNotes update', content: contentB64, branch: APP.branch };
  if (sha) body.sha = sha;
  const res = await fetchWithRetry(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + APP.token },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function ghUploadImage(file) {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const name = `img_${Date.now()}_${newId()}.${ext}`;
  const b64 = await fileToB64(file);
  await ghPut(`${APP.assets}/${name}`, b64, null);
  return `https://raw.githubusercontent.com/${APP.owner}/${APP.repo}/${APP.branch}/${APP.assets}/${name}`;
}

/* —— Gitee 实现（国内直连；token 走 query 参数；base64 内容可能含换行需先清洗） —— */
async function gtFetch(path) {
  const url = `https://gitee.com/api/v5/repos/${APP.owner}/${APP.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(APP.branch)}&access_token=${encodeURIComponent(APP.token)}`;
  const res = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function gtPut(path, contentB64, sha) {
  const url = `https://gitee.com/api/v5/repos/${APP.owner}/${APP.repo}/contents/${encodeURIComponent(path)}`;
  const body = { access_token: APP.token, message: 'MindNotes update', content: contentB64, branch: APP.branch };
  if (sha) body.sha = sha;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function gtDelete(path) {
  const meta = await gtFetch(path);
  const url = `https://gitee.com/api/v5/repos/${APP.owner}/${APP.repo}/contents/${encodeURIComponent(path)}`;
  const res = await fetchWithRetry(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: APP.token, sha: meta.sha, branch: APP.branch, message: 'MindNotes delete' })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}
async function gtUploadImage(file) {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const name = `img_${Date.now()}_${newId()}.${ext}`;
  const b64 = await fileToB64(file);
  await gtPut(`${APP.assets}/${name}`, b64, null);
  return `https://gitee.com/${APP.owner}/${APP.repo}/raw/${APP.branch}/${APP.assets}/${name}`;
}

/* —— 调度层：上层统一调 cloud*，按 APP.provider 分流 —— */
async function cloudFetch(path) { return APP.provider === 'gitee' ? gtFetch(path) : ghFetch(path); }
async function cloudPut(path, b64, sha) { return APP.provider === 'gitee' ? gtPut(path, b64, sha) : ghPut(path, b64, sha); }
async function cloudDelete(path) { return APP.provider === 'gitee' ? gtDelete(path) : ghDelete(path); }
async function cloudUploadImage(file) { return APP.provider === 'gitee' ? gtUploadImage(file) : ghUploadImage(file); }

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result.split(',')[1]));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* =========================================================================
 * 多笔记工作区（Obsidian 式：一个仓库里放多张导图，侧边栏切换）
 * 本地：localStorage 存整个工作区（全部笔记）
 * 云端：notes/index.json 记清单 + 每篇 notes/<id>.json 存树
 * ========================================================================= */
const LS_WORKSPACE = 'mindnotes_workspace';
const LS_USERS = 'mindnotes_users';            // { username: { salt, hash, createdAt } }
const LS_SESSION = 'mindnotes_session';        // { username, loginAt }
const LS_CONFIG = 'mindnotes_config';
/* 工作区命名空间：每账号独立 localStorage 槽位 */
function workspaceKey(user) { return LS_WORKSPACE + ':' + user; }
function userNotesFolder(user) { return (APP.notesFolder || 'notes') + '/' + user; }
function userAssetsFolder(user) { return (APP.assets || 'assets') + '/' + user; }
let notes = {};            // id -> { title, root }
let noteOrder = [];        // 显示顺序（新笔记置顶）
let currentNoteId = null;  // 当前笔记 id

function configured() { return !!(APP.token && APP.owner && APP.repo); }
function notesIndexPath() { return `${userNotesFolder(currentUser)}/index.json`; }
function noteFilePath(id) { return `${userNotesFolder(currentUser)}/${id}.json`; }

/* 序列化时剔掉以 _ 开头的字段（_el 是 DOM 引用，x/y/w/h/_hidden 是布局缓存），
   否则快照里会塞进一堆无用数据，体积能翻好几倍 */
const SNAP_REPLACER = (k, v) => (typeof k === 'string' && k[0] === '_' ? undefined : v);
function serializeTree() { return JSON.stringify({ version: 1, root }, SNAP_REPLACER); }

/* ---- 本地持久化：整个工作区一起存（多笔记共存）---- */
function persistLocal() {
  if (!currentUser) return;
  const obj = {
    version: 1, order: noteOrder, current: currentNoteId,
    notes: Object.fromEntries(noteOrder.map(id => [id, { title: notes[id].title, root: notes[id].root }]))
  };
  try { localStorage.setItem(workspaceKey(currentUser), JSON.stringify(obj, SNAP_REPLACER)); } catch (e) {}
}
function autosaveRaw() { persistLocal(); }
/* autosave = 落盘 + 记一笔历史。所有改动点都调它，历史自动覆盖 */
function autosave() { autosaveRaw(); commitHistory(); }

/* 兼容旧版：把单个 data/mindnotes.json 迁移成一篇笔记 */
function migrateOldLocal() {
  try {
    const raw = localStorage.getItem('mindnotes_local');
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && o.root) return { title: '导入的旧导图', root: o.root };
  } catch (e) {}
  return null;
}
function loadLocalWorkspace() {
  if (!currentUser) return false;
  try {
    const raw = localStorage.getItem(workspaceKey(currentUser));
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (!o || !o.order || !o.order.length) return false;
    notes = {}; noteOrder = [];
    for (const id of o.order) {
      const n = o.notes[id]; if (!n) continue;
      notes[id] = { title: n.title || '未命名', root: n.root };
      noteOrder.push(id);
    }
    currentNoteId = (o.current && notes[o.current]) ? o.current : noteOrder[0];
    return noteOrder.length > 0;
  } catch (e) { return false; }
}

/* ---- 云端持久化 ---- */
async function ghDelete(path) {
  const meta = await ghFetch(path);
  const url = `https://api.github.com/repos/${APP.owner}/${APP.repo}/contents/${encodeURIComponent(path)}`;
  const res = await fetchWithRetry(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + APP.token },
    body: JSON.stringify({ message: 'MindNotes delete', sha: meta.sha, branch: APP.branch })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}
async function putNoteFile(id) {
  const json = JSON.stringify({ version: 1, root: notes[id].root }, SNAP_REPLACER, 2);
  let sha; try { sha = (await cloudFetch(noteFilePath(id))).sha; } catch (e) { sha = undefined; }
  await cloudPut(noteFilePath(id), b64encode(json), sha);
}
async function putManifest() {
  const meta = {}; for (const id of noteOrder) meta[id] = { title: notes[id].title, updated: Date.now() };
  const idx = { version: 1, order: noteOrder, current: currentNoteId, meta };
  let sha; try { sha = (await cloudFetch(notesIndexPath())).sha; } catch (e) { sha = undefined; }
  await cloudPut(notesIndexPath(), b64encode(JSON.stringify(idx, null, 2)), sha);
}
/* 💾 保存：把所有笔记 + 清单一起推到 GitHub */
async function saveWorkspaceToGithub() {
  if (!configured()) { toast('请先打开 ⚙ 设置填 ' + providerLabel() + ' 信息'); return; }
  if (!noteOrder.length) { toast('工作区为空'); return; }
  try {
    await Promise.all(noteOrder.map(id => putNoteFile(id)));
    await putManifest();
    toast('已全部保存到 ' + providerLabel() + ' ✓');
  } catch (e) { toast('保存失败：' + e.message); }
}
async function loadWorkspaceFromGithub() {
  const idx = JSON.parse(b64decode((await cloudFetch(notesIndexPath())).content));
  noteOrder = (idx.order || []).slice();
  currentNoteId = idx.current;
  notes = {};
  for (const id of noteOrder) {
    const f = JSON.parse(b64decode((await cloudFetch(noteFilePath(id))).content));
    const title = (idx.meta && idx.meta[id] && idx.meta[id].title) || '未命名笔记';
    notes[id] = { title, root: f.root };
  }
  if (!noteOrder.length) initDefaultWorkspace();
}
async function reloadWorkspace() {
  if (!configured()) { toast('请先打开 ⚙ 设置填 ' + providerLabel() + ' 信息'); return; }
  if (!confirm('从 ' + providerLabel() + ' 重新加载？本地未保存的改动会被覆盖。')) return;
  try {
    await loadWorkspaceFromGithub();
    root = notes[currentNoteId].root;
    render(); fitView(); selectNode(root.id); renderNoteList(); persistLocal();
    toast('已从 GitHub 加载 ✓');
  } catch (e) { toast('加载失败：' + e.message); }
}

/* ---- 笔记管理：新建 / 切换 / 重命名 / 删除 ---- */
function uniqueDefaultTitle() {
  let i = noteOrder.length + 1, t;
  do { t = '未命名笔记 ' + i; i++; } while (Object.values(notes).some(n => n.title === t));
  return t;
}
function initDefaultWorkspace() {
  const id = newId();
  notes[id] = { title: '我的第一篇笔记', root: seed() };
  noteOrder = [id]; currentNoteId = id;
}
function createNote(title) {
  const id = newId();
  notes[id] = { title: title || uniqueDefaultTitle(), root: newNode('中心主题') };
  noteOrder.unshift(id);
  currentNoteId = id;
  root = notes[id].root;
  render(); fitView(); selectNode(root.id); historyReset();
  renderNoteList(); persistLocal();
  if (configured()) putNoteFile(id).then(putManifest).catch(() => {});
  return id;
}
async function switchNote(id) {
  if (id === currentNoteId || !notes[id]) return;
  syncEditingNode();
  const old = currentNoteId;
  currentNoteId = id;
  root = notes[id].root;
  render(); fitView(); selectNode(root.id); historyReset();
  renderNoteList(); persistLocal();
  if (configured() && old) { try { await putNoteFile(old); await putManifest(); } catch (e) {} }
}
function renameNote(id, title) {
  if (!notes[id]) return;
  notes[id].title = (title || '').trim() || '未命名笔记';
  renderNoteList(); persistLocal();
  if (configured()) putManifest().catch(() => {});
}
async function deleteNote(id) {
  if (noteOrder.length <= 1) { toast('至少保留一个笔记'); return; }
  if (!confirm(`删除笔记「${notes[id].title}」？\n该操作不可恢复。`)) return;
  const idx = noteOrder.indexOf(id);
  noteOrder = noteOrder.filter(x => x !== id);
  delete notes[id];
  if (currentNoteId === id) currentNoteId = noteOrder[Math.max(0, idx - 1)];
  root = notes[currentNoteId] ? notes[currentNoteId].root : newNode('中心主题');
  render(); fitView(); selectNode(root.id); historyReset();
  renderNoteList(); persistLocal();
  if (configured()) { try { await cloudDelete(noteFilePath(id)); await putManifest(); } catch (e) {} }
}

/* ---- 侧边栏渲染 ---- */
function renderNoteList() {
  const ul = document.getElementById('noteList');
  if (!ul) return;
  ul.innerHTML = '';
  const q = (document.getElementById('noteSearch').value || '').trim().toLowerCase();
  for (const id of noteOrder) {
    const n = notes[id]; if (!n) continue;
    if (q && !n.title.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.className = 'note-item' + (id === currentNoteId ? ' active' : '');

    const title = document.createElement('span');
    title.className = 'note-title';
    title.textContent = n.title;
    title.title = '单击改名 · 双击或回车打开';
    /* 单击直接进入行内编辑（解决「新增后无法改名」的痛点） */
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      if (title.isContentEditable) return;   // 已在编辑态
      startInlineRename(title, id);
    });
    /* 双击/回车直接打开（不进入编辑态） */
    title.addEventListener('dblclick', (e) => { e.stopPropagation(); switchNote(id); });

    const actions = document.createElement('span');
    actions.className = 'note-actions';
    const bRename = document.createElement('button');
    bRename.textContent = '✎'; bRename.title = '改名';
    bRename.addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineRename(document.querySelector('.note-item.active .note-title') || title, id);
    });
    const bDel = document.createElement('button');
    bDel.textContent = '🗑'; bDel.title = '删除'; bDel.className = 'del';
    bDel.addEventListener('click', (e) => { e.stopPropagation(); deleteNote(id); });
    actions.append(bRename, bDel);

    li.append(title, actions);
    ul.appendChild(li);
  }
}

/* 行内改名：把 span 切到 contenteditable，Enter 保存 / Esc 取消 / 失焦保存
   用事件委托（keydown 在 #noteList 上）—— 避免 renameNote→renderNoteList 重建 span 丢失监听 */
let _renamingSpan = null;
let _renamingId = null;
let _renameSnapshot = null;
function startInlineRename(span, id) {
  if (!span || !notes[id]) return;
  if (span.isContentEditable) return;
  _renamingSpan = span;
  _renamingId = id;
  _renameSnapshot = span.textContent;
  span.contentEditable = 'true';
  span.classList.add('editing');
  /* 选中全部文字便于覆盖输入 */
  const r = document.createRange();
  r.selectNodeContents(span);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  span.focus();
}
function endInlineRename(commit) {
  const span = _renamingSpan; const id = _renamingId;
  if (!span) return;
  _renamingSpan = null; _renamingId = null;
  span.contentEditable = 'false';
  span.classList.remove('editing');
  if (commit) {
    const t = (span.textContent || '').trim();
    if (t && t !== notes[id].title) {
      notes[id].title = t;
      persistLocal();
      if (configured()) putManifest().catch(() => {});
    } else if (!t) {
      /* 空名 → 强制回退为「未命名笔记」并同步标题 */
      notes[id].title = '未命名笔记';
      persistLocal();
      if (configured()) putManifest().catch(() => {});
      span.textContent = notes[id].title;
    } else {
      span.textContent = notes[id].title;   // 还原（与原值相同）
    }
  } else {
    span.textContent = notes[id].title;   // Esc 还原
  }
  _renameSnapshot = null;
}
/* 事件委托：keydown 装在 #noteList 上，跨 renderNoteList 重建也存活 */
(function wireRenameDelegation() {
  const list = document.getElementById('noteList');
  if (!list) return;
  list.addEventListener('keydown', (e) => {
    if (!_renamingSpan) return;
    if (e.target !== _renamingSpan) return;
    if (e.key === 'Enter') { e.preventDefault(); endInlineRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endInlineRename(false); }
  });
  list.addEventListener('focusout', (e) => {
    if (!_renamingSpan) return;
    if (e.target !== _renamingSpan) return;
    /* 焦点真离开了 span（不是切到自己的子元素） */
    setTimeout(() => {
      if (_renamingSpan && !_renamingSpan.contains(document.activeElement)) endInlineRename(true);
    }, 0);
  });
})();

/* =========================================================================
 * 撤销 / 重做（快照式）
 * 每次改动后把整棵树序列化存进栈；撤销 = 把指针往回拨一步。
 * ========================================================================= */
const HIST = { stack: [], index: -1, limit: 120 };
const btnUndo = document.getElementById('btnUndo');
const btnRedo = document.getElementById('btnRedo');

function snap() { return JSON.stringify({ root, selectedId }, SNAP_REPLACER); }

function commitHistory() {
  const s = snap();
  if (HIST.index >= 0 && HIST.stack[HIST.index] === s) return;   // 无变化不入栈
  HIST.stack = HIST.stack.slice(0, HIST.index + 1);              // 撤销过再改 → 丢弃后面的重做分支
  HIST.stack.push(s);
  if (HIST.stack.length > HIST.limit) HIST.stack.shift();
  HIST.index = HIST.stack.length - 1;
  updateHistBtns();
}
function historyReset() { HIST.stack = [snap()]; HIST.index = 0; updateHistBtns(); }
function updateHistBtns() {
  btnUndo.disabled = HIST.index <= 0;
  btnRedo.disabled = HIST.index >= HIST.stack.length - 1;
}
function restoreState(s) {
  const o = JSON.parse(s);
  root = o.root || root;
  selectedId = (o.selectedId && findNode(root, o.selectedId)) ? o.selectedId : null;
  render();
  if (selectedId) selectNode(selectedId, false);
  autosaveRaw();
}
/* 拖拽 / 缩放 / 看大图时不响应撤销，避免状态错乱 */
function historyBusy() {
  return !!(drag || resizing || panning) || !lightbox.classList.contains('hidden');
}
function undo() {
  if (historyBusy()) return;
  if (HIST.index <= 0) { toast('没有可撤销的操作了'); return; }
  HIST.index--; restoreState(HIST.stack[HIST.index]); updateHistBtns();
}
function redo() {
  if (historyBusy()) return;
  if (HIST.index >= HIST.stack.length - 1) { toast('没有可重做的操作'); return; }
  HIST.index++; restoreState(HIST.stack[HIST.index]); updateHistBtns();
}
/* 把正在编辑的节点内容同步回数据（撤销前先落账，否则会丢最后一次输入） */
function syncEditingNode() {
  const el = document.activeElement;
  if (!el || !el.classList || !el.classList.contains('node-content')) return;
  const n = findNode(root, el.dataset.id);
  if (n) n.content = serializeNode(el.closest('.node'));
}
function exportFile() {
  const blob = new Blob([JSON.stringify({ version: 1, root }, SNAP_REPLACER, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mindnotes.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- Markdown 导出 ---------------- */
/* 把 contenteditable 节点的 HTML 转成 Markdown 片段。
   覆盖：粗/斜/下划/删线、<br>/<p>、<img>、<a>、<code>；样式/颜色/高亮不导出（Markdown 表达不了）。 */
function htmlToMd(html) {
  if (!html) return '';
  let s = html
    /* 表格要最先处理（之后会剥 <tr>/<td>/<th> 这些块级标签） */
    .replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => '\n' + tableHtmlToMd(inner) + '\n')
    /* 块级切段 */
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<(div|li|tr|h[1-6])[^>]*>/gi, '');
  /* 内联：粗/斜/删线/下划/代码/链接/图片 */
  s = s
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<(del|s|strike)>([\s\S]*?)<\/\1>/gi, '~~$2~~')
    .replace(/<u>([\s\S]*?)<\/u>/gi, '<u>$1</u>')                 // Markdown 无原生下划线，保留 HTML（Obsidian 等支持）
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<img [^>]*src="([^"]+)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)')
    .replace(/<img [^>]*src="([^"]+)"[^>]*\/?>/gi, '![]($1)')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
  /* 残余标签去掉，但保留 <u> */
  s = s.replace(/<(?!\/?u\b)[^>]+>/g, '');
  /* 实体还原 */
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  /* 多余空行压一压 */
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
function tableHtmlToMd(inner) {
  /* 把 <tr>...</tr> 切行，<th>/<td> 切列；自动算出列数补齐短行 */
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(inner)) !== null) {
    const cells = [];
    const tdRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cm;
    while ((cm = tdRe.exec(m[1])) !== null) cells.push(htmlToMd(cm[1]));
    rows.push(cells);
  }
  if (!rows.length) return '';
  const cols = Math.max(...rows.map(r => r.length));
  for (const r of rows) while (r.length < cols) r.push('');
  const head = rows[0], body = rows.slice(1);
  const sep = head.map(() => '---');
  const fmt = (r) => '| ' + r.map(c => c.replace(/\|/g, '\\|')).join(' | ') + ' |';
  const lines = [fmt(head), fmt(sep)];
  if (body.length) lines.push(...body.map(fmt));
  return lines.join('\n');
}
/* 节点 → 树形 Markdown。根作为 # 标题，子节点按深度作 ##/###/…（最深 ######），再深退回 - 列表。 */
function treeToMarkdown(rootNode) {
  const lines = [];
  const walk = (n, depth) => {
    const text = htmlToMd(n.content || '') || '（空）';
    if (depth === 0) {
      lines.push('# ' + text);
    } else if (depth <= 5) {
      lines.push('\n' + '#'.repeat(depth + 1) + ' ' + text);
    } else {
      lines.push('\n' + '  '.repeat(depth - 5) + '- ' + text);
    }
    for (const c of (n.children || [])) walk(c, depth + 1);
  };
  walk(rootNode, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
function exportMarkdown() {
  const md = treeToMarkdown(root);
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (notes[currentNoteId] && notes[currentNoteId].title ? notes[currentNoteId].title : 'mindnotes') + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已导出 Markdown ✓');
}

/* ---------------- 跨笔记内容搜索 ---------------- */
/* 扫所有笔记的节点，扁平化后按内容（含 HTML 标签剥掉后纯文本）匹配；返回 [{ noteId, noteTitle, node, snippet }] */
function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function searchAllNotes(q) {
  q = (q || '').trim();
  if (!q) return [];
  const ql = q.toLowerCase();
  const out = [];
  for (const noteId of noteOrder) {
    const note = notes[noteId]; if (!note || !note.root) continue;
    const all = collect(note.root);
    for (const n of all) {
      const text = stripTags(n.content);
      const idx = text.toLowerCase().indexOf(ql);
      if (idx < 0) continue;
      /* 截 ±20 字符做 snippet，并高亮命中段 */
      const start = Math.max(0, idx - 20);
      const end = Math.min(text.length, idx + q.length + 20);
      const before = (start > 0 ? '…' : '') + text.slice(start, idx);
      const hit = text.slice(idx, idx + q.length);
      const after = text.slice(idx + q.length, end) + (end < text.length ? '…' : '');
      out.push({ noteId, noteTitle: note.title, node: n, before, hit, after });
      if (out.length >= 200) return out;       // 硬上限，防卡
    }
  }
  return out;
}
let _searchResults = [];
let _searchActive = 0;        // 当前高亮的结果索引
let _searchDebounce = null;
function openSearch() {
  const m = document.getElementById('searchModal'); if (!m) return;
  m.classList.remove('hidden');
  const input = document.getElementById('searchInput');
  input.value = ''; _searchResults = []; _searchActive = 0;
  document.getElementById('searchResults').innerHTML = '<div class="muted small" style="padding:10px 4px">输入关键词开始搜索（跨所有笔记的节点内容）</div>';
  setTimeout(() => input.focus(), 30);
}
function closeSearch() {
  document.getElementById('searchModal')?.classList.add('hidden');
}
function renderSearchResults() {
  const box = document.getElementById('searchResults');
  if (!_searchResults.length) {
    box.innerHTML = '<div class="muted small" style="padding:10px 4px">没有匹配项</div>';
    return;
  }
  const html = _searchResults.map((r, i) => {
    const activeCls = i === _searchActive ? ' on' : '';
    const noteTag = r.noteId === currentNoteId ? '' : `<span class="sr-note">${escapeHtml(r.noteTitle)}</span>`;
    return `<div class="sr-item${activeCls}" data-i="${i}">
      <div class="sr-text">${noteTag}${escapeHtml(r.before)}<mark>${escapeHtml(r.hit)}</mark>${escapeHtml(r.after)}</div>
    </div>`;
  }).join('');
  box.innerHTML = html;
  /* 把当前选中项滚到可见区 */
  const on = box.querySelector('.sr-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }
async function jumpToSearchResult(i) {
  if (i < 0 || i >= _searchResults.length) return;
  _searchActive = i;
  const r = _searchResults[i];
  if (r.noteId !== currentNoteId) await switchNote(r.noteId);
  /* 把命中的祖先全部展开（如果有 collapsed） */
  const ancestors = findAncestors(r.noteId, r.node.id);
  for (const a of ancestors) a.collapsed = false;
  render(); fitView();
  selectNode(r.node.id);
  /* 把节点带进视野：scrollIntoView 不够，强制把视口移到节点位置 */
  const el = r.node._el;
  if (el) {
    const r2 = el.getBoundingClientRect();
    const vw = viewport.getBoundingClientRect();
    const cx = r2.left - vw.left - vw.width / 2 + r2.width / 2;
    const cy = r2.top - vw.top - vw.height / 2 + r2.height / 2;
    tx += cx; ty += cy; applyTransform();
  }
  renderSearchResults();
}
function findAncestors(noteId, targetId) {
  /* BFS 找 targetId 的祖先链（不含 target 自身） */
  const rootN = notes[noteId] && notes[noteId].root;
  if (!rootN) return [];
  const path = [];
  const walk = (n, trail) => {
    if (n.id === targetId) { path.push(...trail); return true; }
    for (const c of n.children || []) if (walk(c, [...trail, n])) return true;
    return false;
  };
  walk(rootN, []);
  return path;
}
function wireSearch() {
  const input = document.getElementById('searchInput');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      _searchResults = searchAllNotes(input.value);
      _searchActive = 0;
      renderSearchResults();
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearch(); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); jumpToSearchResult(Math.min(_searchActive + 1, _searchResults.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); jumpToSearchResult(Math.max(_searchActive - 1, 0)); return; }
    if (e.key === 'Enter')     { e.preventDefault(); jumpToSearchResult(_searchActive); return; }
  });
  document.getElementById('searchResults').addEventListener('click', (e) => {
    const it = e.target.closest('.sr-item'); if (!it) return;
    jumpToSearchResult(parseInt(it.dataset.i, 10));
  });
  document.getElementById('searchModal').addEventListener('click', (e) => {
    if (e.target.id === 'searchModal') closeSearch();   // 点遮罩关闭
  });
}

/* ---------------- 视图变换 ---------------- */
function fitView() {
  const all = collect(root).filter(n => !n._hidden);
  let maxX = 0, maxY = 0;
  for (const n of all) { maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h); }
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  scale = Math.min(1, (vw - 120) / (maxX + 80), (vh - 120) / (maxY + 80));
  scale = Math.max(0.2, scale);
  tx = 60; ty = Math.max(60, (vh - maxY * scale) / 2);
  applyTransform();
}
function zoom(factor, cx, cy) {
  const rect = viewport.getBoundingClientRect();
  const mx = cx ?? rect.width / 2, my = cy ?? rect.height / 2;
  const ns = Math.min(3, Math.max(0.2, scale * factor));
  tx = mx - (mx - tx) * (ns / scale);
  ty = my - (my - ty) * (ns / scale);
  scale = ns; applyTransform();
}

/* ---------------- 事件绑定 ---------------- */
document.getElementById('toolbar').addEventListener('click', (e) => {
  const act = e.target.dataset.act; if (!act) return;
  ({
    undo, redo,
    new: () => createNote(),
    addChild: addChild, addSibling: addSibling, delete: deleteNode, copy: copySelectedNodeContent,
    image: () => fileInput.click(), table: insertTable, style: toggleStylePanel,
    fit: fitView, zoomIn: () => zoom(1.15), zoomOut: () => zoom(0.87),
    save: saveWorkspaceToGithub, load: reloadWorkspace, export: exportFile, exportMd: exportMarkdown, search: openSearch,
    settings: openSettings, import: openImport, png: openPngModal
  })[act]?.();
});

/* ---------------- 节点右键菜单 ---------------- */
const nodeMenu = document.getElementById('nodeMenu');
function hideNodeMenu() { if (nodeMenu) nodeMenu.classList.add('hidden'); }
function showNodeMenu(node, x, y) {
  if (!nodeMenu || !node) return;
  selectNode(node.id, false);
  nodeMenu.classList.remove('hidden');
  const mw = nodeMenu.offsetWidth, mh = nodeMenu.offsetHeight;
  const px = Math.min(x, window.innerWidth - mw - 8);
  const py = Math.min(y, window.innerHeight - mh - 8);
  nodeMenu.style.left = px + 'px';
  nodeMenu.style.top = py + 'px';
}
nodesLayer.addEventListener('contextmenu', (e) => {
  const el = e.target.closest && e.target.closest('.node');
  if (!el) return;                       // 空白处保留浏览器默认菜单
  e.preventDefault();
  const n = findNode(root, el.dataset.id);
  showNodeMenu(n, e.clientX, e.clientY);
});
nodeMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  const act = btn && btn.dataset.menu;
  if (!act) return;
  if (act === 'copy') copySelectedNodeContent();
  else if (act === 'copyText') copyNodePlain();
  else if (act === 'copyTree') copyNodeSubtreeOutline();
  else if (act === 'copyBranch') copyBranch();
  else if (act === 'pasteBranch') pasteBranch();
  else if (act === 'addChild') addChild();
  else if (act === 'addSibling') addSibling();
  else if (act === 'style') toggleStylePanel();
  else if (act === 'delete') deleteNode();
  hideNodeMenu();
});
/* 点菜单外 / 失焦 / 滚动 → 关闭 */
document.addEventListener('mousedown', (e) => {
  if (nodeMenu && !nodeMenu.classList.contains('hidden') && !nodeMenu.contains(e.target)) hideNodeMenu();
});
window.addEventListener('blur', hideNodeMenu);
window.addEventListener('scroll', hideNodeMenu, true);

fileInput.addEventListener('change', (e) => {
  const f = e.target.files[0]; if (f) insertImageFromFile(f);
  fileInput.value = '';
});

/* 平移：在空白处拖动 */
viewport.addEventListener('mousedown', (e) => {
  if (e.target.closest('.node')) return;
  panning = true; viewport.classList.add('panning');
  panStart = { x: e.clientX - tx, y: e.clientY - ty };
});
window.addEventListener('mousemove', (e) => {
  if (!panning) return;
  tx = e.clientX - panStart.x; ty = e.clientY - panStart.y; applyTransform();
});
window.addEventListener('mouseup', () => { panning = false; viewport.classList.remove('panning'); });

/* 缩放 */
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  zoom(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

/* 快捷键 */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideNodeMenu();
    if (drag) cancelDrag();
    else if (typeof hideImgHandle === 'function') hideImgHandle();
    if (!lightbox.classList.contains('hidden')) closeLightbox();
    else if (!stylePanel.classList.contains('hidden')) stylePanel.classList.add('hidden');
    else if (!document.getElementById('settingsModal').classList.contains('hidden'))
      document.getElementById('settingsModal').classList.add('hidden');
    else if (!document.getElementById('searchModal').classList.contains('hidden')) closeSearch();
    return;
  }
  /* Ctrl+F：跨笔记搜索（在任何地方都接管，包括节点内/输入框） */
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    openSearch();
    return;
  }
  /* 撤销 / 重做：节点内编辑时也接管（先同步当前输入，再回退一步） */
  const tag = (e.target.tagName || '').toUpperCase();
  if ((e.ctrlKey || e.metaKey) && ['z', 'Z', 'y', 'Y'].includes(e.key)) {
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;      // 输入框里交回浏览器
    e.preventDefault();
    syncEditingNode();
    if (e.key === 'y' || e.key === 'Y' || e.shiftKey) redo(); else undo();
    return;
  }
  /* 复制节点内容：选中节点后 Ctrl/Cmd+C（不含 Shift，Shift 留给「复制分支」）。
     若节点内已选了文字，则交给浏览器原生复制；否则复制整个节点内容（HTML + 纯文本） */
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
    const t0 = (e.target.tagName || '').toUpperCase();
    if (t0 === 'INPUT' || t0 === 'TEXTAREA') return;          // 输入框复制交回浏览器
    if (!selectedId) return;
    const sel0 = window.getSelection();
    if (sel0 && sel0.toString().trim().length > 0) return;    // 选了节点内文字 → 原生复制
    e.preventDefault(); copySelectedNodeContent();
    return;
  }
  /* 复制/粘贴整棵分支到「内部剪贴板」（不受 file:// 系统剪贴板权限限制；保留样式/图片） */
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copyBranch(); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteBranch(); return; }
  if (e.target.isContentEditable) {
    if (e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) promoteNode(); else addChild(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); addChild(); }            // 加子级并聚焦
    else if (e.key === 'Enter' && !e.shiftKey && !(e.ctrlKey || e.metaKey)) { e.preventDefault(); addEnterNode(); }  // 同级；Shift+Enter 保留节点内换行
    return;
  }
  const t2 = (e.target.tagName || '').toUpperCase();
  /* 选中节点但未编辑态：Tab 加子级 / Tab+Shift 升级 / Ctrl+Enter 加子级 / Enter 同级 / Delete 删除 */
  if (e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) promoteNode(); else addChild(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && selectedId) { e.preventDefault(); addChild(); return; }
  if (e.key === 'Delete' && selectedId && t2 !== 'INPUT' && t2 !== 'TEXTAREA' && t2 !== 'BUTTON') {
    e.preventDefault(); deleteNode(); return;
  }
  if (e.key === 'Enter' && selectedId && !e.ctrlKey && !e.metaKey &&
      t2 !== 'BUTTON' && t2 !== 'INPUT' && t2 !== 'TEXTAREA') {
    e.preventDefault(); addEnterNode();
  }
});

/* 设置弹窗 */
function openSettings() {
  document.getElementById('setOwner').value = APP.owner;
  document.getElementById('setRepo').value = APP.repo;
  document.getElementById('setBranch').value = APP.branch;
  document.getElementById('setToken').value = APP.token;
  document.getElementById('setNotesFolder').value = APP.notesFolder;
  document.getElementById('setAssets').value = APP.assets;
  document.getElementById('settingsModal').classList.remove('hidden');
}
document.getElementById('setClose').addEventListener('click', () => document.getElementById('settingsModal').classList.add('hidden'));
document.getElementById('setSave').addEventListener('click', () => {
  APP.provider = document.getElementById('setProvider').value || 'github';
  APP.owner = document.getElementById('setOwner').value.trim();
  APP.repo = document.getElementById('setRepo').value.trim();
  APP.branch = document.getElementById('setBranch').value.trim() || (APP.provider === 'gitee' ? 'master' : 'main');
  APP.token = document.getElementById('setToken').value.trim();
  APP.notesFolder = document.getElementById('setNotesFolder').value.trim() || 'notes';
  APP.assets = document.getElementById('setAssets').value.trim() || 'assets';
  localStorage.setItem(LS_CONFIG, JSON.stringify(APP));
  document.getElementById('settingsModal').classList.add('hidden');
  toast('设置已保存（本机）· 当前平台：' + providerLabel());
});
function loadConfig() {
  try { const c = JSON.parse(localStorage.getItem(LS_CONFIG)); if (c) Object.assign(APP, c); } catch (e) {}
}

/* 设置弹窗里的「测试连接」：验证 owner/repo/token 是否正确、Token 是否有 repo 权限 */
async function testConnection() {
  if (!configured()) { toast('请先填写 用户名 / 仓库 / Token'); return; }
  const isGitee = APP.provider === 'gitee';
  try {
    const url = isGitee
      ? `https://gitee.com/api/v5/repos/${APP.owner}/${APP.repo}?access_token=${encodeURIComponent(APP.token)}`
      : `https://api.github.com/repos/${APP.owner}/${APP.repo}`;
    const headers = isGitee
      ? { 'Accept': 'application/json' }
      : { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + APP.token };
    const res = await fetchWithRetry(url, { headers });
    if (res.status === 401) { toast('❌ Token 无效或无权限'); return; }
    if (res.status === 404) { toast('❌ 仓库不存在或无权限（确认仓库名，且 Token 需有 repo 权限）'); return; }
    if (!res.ok) { toast('❌ 连接失败：HTTP ' + res.status); return; }
    const data = await res.json().catch(() => ({}));
    toast('✅ 连接成功：' + (data.full_name || (APP.owner + '/' + APP.repo)));
  } catch (e) {
    toast('❌ 连接失败：' + (e && e.message ? e.message : e) + '（可能网络不通）');
  }
}
document.getElementById('btnTestConn').addEventListener('click', testConnection);

/* =========================================================================
 * 图片放大查看器（Lightbox）
 * ========================================================================= */
const lightbox = document.getElementById('lightbox');
const lbImg = document.getElementById('lbImg');
const lbStage = document.getElementById('lbStage');
const lbScaleTxt = document.getElementById('lbScale');
let lbScale = 1, lbX = 0, lbY = 0;
let lbDragging = false, lbMoved = false, lbDragStart = null, lbCurrentSrc = '';

function lbApply() {
  lbImg.style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbScale})`;
  lbScaleTxt.textContent = Math.round(lbScale * 100) + '%';
}
function lbZoom(factor) {
  lbScale = Math.min(8, Math.max(0.1, lbScale * factor));
  lbApply();
}
function lbFit() {
  lbScale = 1; lbX = 0; lbY = 0;
  lbImg.style.maxWidth = '92%';
  lbImg.style.maxHeight = '88%';
  lbApply();
}
function lbOriginal() {
  lbScale = 1; lbX = 0; lbY = 0;
  lbImg.style.maxWidth = 'none';
  lbImg.style.maxHeight = 'none';
  lbApply();
}
function openLightbox(src) {
  lbCurrentSrc = src;
  lbImg.src = src;
  lbFit();
  lightbox.classList.remove('hidden');
}
function closeLightbox() {
  lightbox.classList.add('hidden');
  lbImg.src = '';
  lbCurrentSrc = '';
}

/* 节点内图片：mousedown 阻止光标定位，click 打开放大 */
nodesLayer.addEventListener('mousedown', (e) => {
  if (e.target.tagName === 'IMG') { e.preventDefault(); e.stopPropagation(); }
});
nodesLayer.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG') { e.stopPropagation(); openLightbox(e.target.src); }
});

/* 查看器交互：按钮 / 滚轮 / 拖动 / 点空白关闭 */
document.querySelector('.lb-bar').addEventListener('click', (e) => {
  const act = e.target.dataset.lb; if (!act) return;
  if (act === 'in') lbZoom(1.2);
  else if (act === 'out') lbZoom(0.83);
  else if (act === 'fit') lbFit();
  else if (act === 'orig') lbOriginal();
  else if (act === 'close') closeLightbox();
  else if (act === 'del') deleteImageFromNode();
});
lbStage.addEventListener('wheel', (e) => {
  e.preventDefault();
  lbZoom(e.deltaY < 0 ? 1.12 : 0.89);
}, { passive: false });
lbStage.addEventListener('mousedown', (e) => {
  lbDragging = true; lbMoved = false;
  lbStage.classList.add('grabbing');
  lbDragStart = { x: e.clientX - lbX, y: e.clientY - lbY, mx: e.clientX, my: e.clientY };
});
window.addEventListener('mousemove', (e) => {
  if (!lbDragging) return;
  if (Math.abs(e.clientX - lbDragStart.mx) > 4 || Math.abs(e.clientY - lbDragStart.my) > 4) lbMoved = true;
  lbX = e.clientX - lbDragStart.x; lbY = e.clientY - lbDragStart.y;
  lbApply();
});
window.addEventListener('mouseup', () => {
  if (lbDragging) { lbDragging = false; lbStage.classList.remove('grabbing'); }
});
/* 点空白处关闭（拖动过就不关，避免误触） */
lbStage.addEventListener('click', (e) => {
  if (!lbMoved && e.target !== lbImg) closeLightbox();
});

/* 从节点里删掉当前查看的这张图 */
function deleteImageFromNode() {
  const imgs = [...nodesLayer.querySelectorAll('img')];
  const target = imgs.find(i => i.src === lbCurrentSrc);
  if (!target) { toast('没找到这张图'); return; }
  const hostNode = target.closest('.node');
  target.remove();
  const n = findNode(root, hostNode.dataset.id);
  if (n) { n.content = serializeNode(hostNode); autosave(); }
  hideImgHandle();
  closeLightbox();
  toast('图片已删除');
}

/* =========================================================================
 * 图片拖拽调整大小
 * 手柄是浮在 #canvas 上的独立元素（不进节点 DOM，不会被存进数据）
 * ========================================================================= */
const imgHandle = document.getElementById('imgHandle');
let handleImg = null;          // 当前手柄对应的 <img>
let resizing = false;          // 图片 resize
let resizingNode = null;       // 节点 resize: { id, startX, startY, startW, startH, mode: 'xy'|'x'|'y' }
let resizingNodeStart = null;
let resizeStart = null;        // { x, w }

function showImgHandle(img) {
  handleImg = img;
  imgHandle.classList.remove('hidden');
  positionImgHandle();
}
function hideImgHandle() {
  if (resizing) return;
  handleImg = null;
  imgHandle.classList.add('hidden');
}
function positionImgHandle() {
  if (!handleImg || imgHandle.classList.contains('hidden')) return;
  const r = handleImg.getBoundingClientRect();
  const cr = canvas.getBoundingClientRect();
  const x = (r.left - cr.left) / scale;
  const y = (r.top - cr.top) / scale;
  const w = r.width / scale, h = r.height / scale;
  imgHandle.style.left = (x + w - 8) + 'px';
  imgHandle.style.top = (y + h - 8) + 'px';
}

nodesLayer.addEventListener('mouseover', (e) => {
  if (e.target.tagName === 'IMG' && !drag && !resizing) showImgHandle(e.target);
});
nodesLayer.addEventListener('mouseout', (e) => {
  if (e.target.tagName === 'IMG' && e.relatedTarget !== imgHandle) hideImgHandle();
});

imgHandle.addEventListener('mouseleave', () => hideImgHandle());
imgHandle.addEventListener('mousedown', (e) => {
  if (!handleImg) return;
  e.preventDefault(); e.stopPropagation();
  resizing = true;
  resizeStart = { x: e.clientX, w: handleImg.getBoundingClientRect().width / scale };
});
window.addEventListener('mousemove', (e) => {
  if (!resizing || !handleImg) return;
  const nw = Math.max(40, Math.round(resizeStart.w + (e.clientX - resizeStart.x) / scale));
  handleImg.style.width = nw + 'px';
  handleImg.style.height = 'auto';
  handleImg.classList.add('resized');
  layout(); drawEdges();      // 先重排（节点会跟着变高），再把手柄贴到图右下角
  positionImgHandle();
});
window.addEventListener('mouseup', () => {
  if (!resizing) return;
  resizing = false;
  if (handleImg) {
    const host = handleImg.closest('.node');
    const n = host && findNode(root, host.dataset.id);
    if (n) {
      // 图放大到超过节点默认宽度时，把节点一起撑宽（否则图会被裁）
      const finalW = Math.round(handleImg.getBoundingClientRect().width / scale);
      const needW = finalW + 26;
      n.style = n.style || {};
      if (needW > 340) n.style.maxW = needW; else delete n.style.maxW;
      applyNodeStyle(host, n);
      n.content = serializeNode(host);
      autosave();
    }
  }
  layout(); drawEdges();
  positionImgHandle();
});

/* =========================================================================
 * 节点尺寸调整：右下角手柄拖动改宽度/高度
 * - 默认同时改宽 + 改高
 * - Ctrl 只改高（手柄上下拖）
 * - Shift 只改宽（手柄左右拖）
 * - 改完存到 n.style.minW / minH，跟着 workspace 一起持久化
 * - applyNodeStyle 在 render 时把这些样式重新套回去
 * ========================================================================= */
function startNodeResize(id, e) {
  const n = findNode(root, id);
  if (!n || !n._el) return;
  resizingNode = id;
  const r = n._el.getBoundingClientRect();
  resizingNodeStart = {
    x: e.clientX, y: e.clientY,
    startW: r.width, startH: r.height,
    curW: (n.style && n.style.minW) || 0,
    curH: (n.style && n.style.minH) || 0,
  };
  /* 立刻给个最小值（120x40），避免无样式节点 width=0 的极小情况 */
  if (!resizingNodeStart.curW) resizingNodeStart.curW = Math.max(120, r.width);
  if (!resizingNodeStart.curH) resizingNodeStart.curH = Math.max(40, r.height);
  document.body.style.cursor = e.shiftKey ? 'ew-resize' : e.ctrlKey ? 'ns-resize' : 'nwse-resize';
  /* 阻止 mousedown 冒泡触发 selectNode 的"非编辑态 focus"逻辑 */
  e.preventDefault();
}
window.addEventListener('mousemove', (e) => {
  if (!resizingNode) return;
  const n = findNode(root, resizingNode);
  if (!n || !n._el) return;
  const dx = (e.clientX - resizingNodeStart.x) / scale;
  const dy = (e.clientY - resizingNodeStart.y) / scale;
  /* 限制：最小宽 80 / 最小高 28（保留一行文字+padding），最大宽 2000 / 最大高 1500 */
  const minW = 80, maxW = 2000, minH = 28, maxH = 1500;
  /* Shift = 只改宽（跳过高度）；Ctrl = 只改高（跳过宽度）；都不按 = 都改 */
  const skipH = e.shiftKey;   // Shift 锁定宽
  const skipW = e.ctrlKey;    // Ctrl 锁定高
  n.style = n.style || {};
  if (!skipW) {
    const newW = Math.max(minW, Math.min(maxW, Math.round(resizingNodeStart.startW + dx)));
    n.style.minW = newW;
  }
  if (!skipH) {
    const newH = Math.max(minH, Math.min(maxH, Math.round(resizingNodeStart.startH + dy)));
    n.style.minH = newH;
  }
  applyNodeStyle(n._el, n);
  /* 拖动过程中也要重排 + 重画线，否则兄弟节点位置不变会重叠 */
  layout(); drawEdges();
  document.body.style.cursor = skipH ? 'ew-resize' : skipW ? 'ns-resize' : 'nwse-resize';
});
window.addEventListener('mouseup', () => {
  if (!resizingNode) return;
  const n = findNode(root, resizingNode);
  resizingNode = null;
  resizingNodeStart = null;
  document.body.style.cursor = '';
  if (n) {
    /* 落账：commit 历史 + autosave */
    autosave();
  }
});
/* 公开：恢复节点默认尺寸（清掉自定义 minW/minH/maxW） */
function resetNodeSize(id) {
  const n = id ? findNode(root, id) : (selectedId ? findNode(root, selectedId) : null);
  if (!n) return;
  if (n.style) { delete n.style.minW; delete n.style.minH; delete n.style.maxW; }
  if (n._el) applyNodeStyle(n._el, n);
  layout(); drawEdges();
  autosave();
}

/* =========================================================================
 * 节点拖拽换父级
 * ========================================================================= */
let drag = null;               // { id }
let pending = null;            // 阈值拖拽：{ id, x, y }
let typing = false;            // 节点内是否正在输入文字（用于区分 Delete 删字 / 删节点）

function isDescendantOf(ancestorId, maybeChildId) {
  const a = findNode(root, ancestorId);
  if (!a) return false;
  return collect(a).some(n => n.id === maybeChildId);
}
function plainText(html) {
  const d = document.createElement('div');
  d.innerHTML = (html || '').replace(/<[^>]*>/g, ' ');
  return (d.textContent || '').trim().slice(0, 14) || '该节点';
}

function startDrag(id) {
  drag = { id };
  const n = findNode(root, id);
  if (n && n._el) n._el.classList.add('dragging');
  document.body.classList.add('dragging-node');
  hideImgHandle();
}
function cancelDrag() {
  if (!drag) return;
  const n = findNode(root, drag.id);
  if (n && n._el) n._el.classList.remove('dragging');
  clearDropTargets();
  document.body.classList.remove('dragging-node');
  drag = null;
}
function clearDropTargets() {
  nodesLayer.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
}

window.addEventListener('mousemove', (e) => {
  if (drag) {
    clearDropTargets();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const host = el && el.closest ? el.closest('.node') : null;
    if (!host) return;
    const tid = host.dataset.id;
    // 不能放到自己、也不能放到自己的子孙下面（否则结构成环）
    if (tid === drag.id || isDescendantOf(drag.id, tid)) return;
    host.classList.add('drop-target');
    return;
  }
  if (pending) {
    const dx = e.clientX - pending.x, dy = e.clientY - pending.y;
    if (dx * dx + dy * dy > 100) { startDrag(pending.id); pending = null; }  // 移动 >10px 才判定为拖拽，避免单击手抖误触
  }
});

window.addEventListener('mouseup', () => {
  if (drag) {
    const srcId = drag.id;
    const target = nodesLayer.querySelector('.drop-target');
    clearDropTargets();
    const srcNode = findNode(root, srcId);
    if (srcNode && srcNode._el) srcNode._el.classList.remove('dragging');
    document.body.classList.remove('dragging-node');
    drag = null;

    if (!target) return;
    const tid = target.dataset.id;
    if (tid === srcId || isDescendantOf(srcId, tid)) return;

    const parent = findParent(root, srcId);
    if (parent === null) { toast('根节点不能移动'); return; }
    if (parent === undefined) return;

    parent.children = parent.children.filter(c => c.id !== srcId);
    const t = findNode(root, tid);
    t.collapsed = false;
    t.children.push(srcNode);

    render(); autosave();
    toast(`已移入「${plainText(t.content)}」下`);
    return;
  }
  if (pending) {
    if (!pending.editing) selectNode(pending.id, true);   // 非编辑态单击 = 进入编辑；编辑态保持原状（光标已在节点内）
    pending = null;
  }
});

/* =========================================================================
 * 样式面板
 * ========================================================================= */
const stylePanel = document.getElementById('stylePanel');
const spSize = document.getElementById('spSize');
const spSizeVal = document.getElementById('spSizeVal');
const spColor = document.getElementById('spColor');
const spBg = document.getElementById('spBg');
const spBorder = document.getElementById('spBorder');

function currentNode() { return selectedId ? findNode(root, selectedId) : null; }

/* 光标是否在「选中节点」内选了一段文字 */
function hasTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const anchor = sel.anchorNode;
  const el = anchor && anchor.nodeType === 1 ? anchor : (anchor && anchor.parentElement);
  const host = el && el.closest ? el.closest('.node') : null;
  return !!(host && host.dataset.id === selectedId);
}

/* 给选中的文字套一层带样式的 span */
function wrapSelection(cssText) {
  const sel = window.getSelection();
  const range = sel.getRangeAt(0);
  const span = document.createElement('span');
  span.style.cssText = cssText;
  span.appendChild(range.extractContents());
  range.insertNode(span);
  sel.removeAllRanges();
}

function toggleStylePanel() {
  if (!stylePanel.classList.contains('hidden')) { stylePanel.classList.add('hidden'); return; }
  if (!selectedId) { toast('先选中一个节点'); return; }
  syncStylePanel();
  stylePanel.classList.remove('hidden');
}
function syncStylePanel() {
  const n = currentNode(); if (!n) return;
  const s = n.style || {};
  spSize.value = s.fontSize || 14;
  spSizeVal.textContent = (s.fontSize || 14) + 'px';
  spColor.value = s.color || '#e6e9ef';
  spBg.value = s.bg || '#1d2230';
  spBorder.value = s.border || '#39414f';
  const btns = stylePanel.querySelectorAll('[data-sp]');
  btns.forEach(b => b.classList.toggle('on',
    (b.dataset.sp === 'bold' && s.bold) ||
    (b.dataset.sp === 'italic' && s.italic) ||
    (b.dataset.sp === 'highlight' && s.highlight)
  ));
}
function refreshNodeContent(n) {
  if (!n || !n._el) return;
  n.content = serializeNode(n._el);
  autosave();
  layout(); drawEdges();
}

/* 应用样式：有选区 → 改文字；无选区 → 改整个节点 */
function applyStyle(action, value) {
  const n = currentNode();
  if (!n) { toast('先选中一个节点'); return; }
  const inSel = hasTextSelection();

  /* --- 作用于选中的一段文字 --- */
  if (inSel && ['bold', 'italic', 'underline', 'strike', 'color', 'fontSize'].includes(action)) {
    n._el.querySelector('.node-content').focus();
    try {
      if (action === 'bold')      document.execCommand('bold');
      else if (action === 'italic')    document.execCommand('italic');
      else if (action === 'underline') document.execCommand('underline');
      else if (action === 'strike')    document.execCommand('strikeThrough');
      else if (action === 'color') {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('foreColor', false, value);
      }
      else if (action === 'fontSize') wrapSelection(`font-size:${value}px;`);
    } catch (e) { toast('该浏览器不支持此操作'); }
    refreshNodeContent(n);
    return;
  }

  /* --- 作用于整个节点 --- */
  n.style = n.style || {};
  if (action === 'fontSize') n.style.fontSize = +value;
  else if (action === 'color') n.style.color = value;
  else if (action === 'bg') n.style.bg = value;
  else if (action === 'border') n.style.border = value;
  else if (action === 'bold') n.style.bold = !n.style.bold;
  else if (action === 'italic') n.style.italic = !n.style.italic;
  else if (action === 'highlight') n.style.highlight = !n.style.highlight;
  else if (action === 'reset') { n.style = {}; }
  else if (action === 'resetSize') { if (n.style) { delete n.style.minW; delete n.style.minH; delete n.style.maxW; } }
  applyNodeStyle(n._el, n);
  syncStylePanel();
  autosave();
  layout(); drawEdges();
}

/* 点按钮时保住节点内的文字选区（不让它失焦） */
stylePanel.addEventListener('mousedown', (e) => {
  if (e.target.closest('[data-sp]') || e.target.closest('.sp-sw i')) e.preventDefault();
});

/* 样式面板事件绑定 */
stylePanel.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sp]');
  if (b) { applyStyle(b.dataset.sp); return; }
  const sw = e.target.closest('.sp-sw i');
  if (sw) {
    const target = sw.parentElement.dataset.target;   // color / bg
    const val = sw.style.background;
    if (target === 'color') { spColor.value = rgbToHex(val); applyStyle('color', rgbToHex(val)); }
    else { spBg.value = rgbToHex(val); applyStyle('bg', rgbToHex(val)); }
  }
});
document.getElementById('spClose').addEventListener('click', () => stylePanel.classList.add('hidden'));
spSize.addEventListener('input', () => {
  spSizeVal.textContent = spSize.value + 'px';
  applyStyle('fontSize', spSize.value);
});
spColor.addEventListener('input', () => applyStyle('color', spColor.value));
spBg.addEventListener('input', () => applyStyle('bg', spBg.value));
spBorder.addEventListener('input', () => applyStyle('border', spBorder.value));

function rgbToHex(rgb) {
  const m = rgb.match(/\d+/g);
  if (!m) return '#000000';
  return '#' + m.slice(0, 3).map(x => (+x).toString(16).padStart(2, '0')).join('');
}

/* =========================================================================
 * ZIP 解压 —— XMind / WPS .pos 都是 zip 包
 * 用浏览器内置的 DecompressionStream，不引第三方库
 * ========================================================================= */
async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('当前浏览器不支持解压，请用 Chrome / Edge 103+');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buf) {
  /* 同时接受 ArrayBuffer 和 Uint8Array（含 Node Buffer），测试环境也能跑 */
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的压缩包');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize  = dv.getUint32(off + 20, true);
    const nlen   = dv.getUint16(off + 28, true);
    const elen   = dv.getUint16(off + 30, true);
    const clen   = dv.getUint16(off + 32, true);
    const lho    = dv.getUint32(off + 42, true);
    const name   = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen));
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) { continue; }
    const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    entries.push({ name, method, raw: u8.subarray(start, start + csize) });
  }
  const zip = { text: {}, raw: {} };
  for (const e of entries) {
    zip.raw[e.name] = e.raw;
    let bytes;
    if (e.method === 0) bytes = e.raw;
    else if (e.method === 8) { try { bytes = await inflateRaw(e.raw); } catch (err) { continue; } }
    else continue;
    zip.text[e.name] = new TextDecoder('utf-8').decode(bytes);
  }
  return zip;
}

function dataUrlFromBytes(bytes, name) {
  const ext = (name.split('.').pop() || 'png').toLowerCase();
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'image/png';
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/* =========================================================================
 * 导入：格式解析
 * 飞书思维笔记 → 导出 FreeMind(.mm)；WPS 思维导图 → 导出 .mm / .opml / .txt
 * 另外支持 .xmind、Markdown/缩进大纲文本、本工具 .json 备份
 * ========================================================================= */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* 行内 Markdown：**粗** *斜* `代码` [链接](url) */
function inlineMd(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}
function mkNode(html, children = []) { const n = newNode(html); n.children = children; return n; }

/* --- FreeMind .mm（飞书 / WPS 都能导出） --- */
function parseFreemind(txt) {
  const doc = new DOMParser().parseFromString(txt, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML 解析失败');
  const map = doc.querySelector('map');
  if (!map) throw new Error('不是 FreeMind 文件（找不到 <map>）');
  const conv = (el) => {
    const n = newNode(escapeHtml(el.getAttribute('TEXT') || ''));
    const rc = [...el.children].find(e => e.nodeName === 'richcontent');
    if (rc && rc.textContent.trim()) {
      const tmp = document.createElement('div');
      tmp.innerHTML = rc.textContent;
      const body = tmp.querySelector('body');
      const html = (body ? body.innerHTML : tmp.innerHTML).trim();
      if (html) n.content = html;
    }
    n.children = [...el.children].filter(e => e.nodeName === 'node').map(conv);
    return n;
  };
  const tops = [...map.children].filter(e => e.nodeName === 'node');
  if (!tops.length) throw new Error('文件里没有任何节点');
  return tops.length === 1 ? conv(tops[0]) : mkNode('导入的导图', tops.map(conv));
}

/* --- OPML --- */
function parseOpml(txt) {
  const doc = new DOMParser().parseFromString(txt, 'application/xml');
  const body = doc.querySelector('body');
  if (!body) throw new Error('不是 OPML 文件（找不到 <body>）');
  const conv = (el) => {
    const n = newNode(escapeHtml(el.getAttribute('text') || el.getAttribute('title') || ''));
    n.children = [...el.children].filter(e => e.nodeName === 'outline').map(conv);
    return n;
  };
  const tops = [...body.children].filter(e => e.nodeName === 'outline');
  if (!tops.length) throw new Error('OPML 里没有任何节点');
  return tops.length === 1 ? conv(tops[0]) : mkNode('导入的导图', tops.map(conv));
}

/* --- XMind Zen (content.json) --- */
function parseXmindJson(txt, zip) {
  const sheets = JSON.parse(txt);
  if (!Array.isArray(sheets) || !sheets[0] || !sheets[0].rootTopic)
    throw new Error('XMind content.json 格式异常');
  const conv = (t) => {
    let html = escapeHtml(t.title || '');
    if (t.image && t.image.src && zip && zip.raw && zip.raw[t.image.src])
      html += `<br><img src="${dataUrlFromBytes(zip.raw[t.image.src], t.image.src)}">`;
    if (t.notes && t.notes.plain && t.notes.plain.content)
      html += '<div>' + escapeHtml(t.notes.plain.content).replace(/\n/g, '<br>') + '</div>';
    const n = newNode(html);
    const kids = (t.children && t.children.attached) || [];
    n.children = kids.map(conv);
    return n;
  };
  return conv(sheets[0].rootTopic);
}

/* --- XMind 8 及更早 (content.xml) --- */
function parseXmindXml(txt) {
  const doc = new DOMParser().parseFromString(txt, 'application/xml');
  const topic = doc.querySelector('sheet > topic') || doc.querySelector('topic');
  if (!topic) throw new Error('不是 XMind content.xml');
  const conv = (el) => {
    const t = [...el.children].find(e => e.nodeName === 'title');
    const n = newNode(escapeHtml(t ? t.textContent : ''));
    const holder = [...el.children].find(e => e.nodeName === 'children');
    const box = holder && [...holder.children].find(e => (e.getAttribute('type') || '') === 'attached');
    n.children = box ? [...box.children].filter(e => e.nodeName === 'topic').map(conv) : [];
    return n;
  };
  return conv(topic);
}

/* --- Markdown 表格块 → HTML --- */
function tableToHtml(rows) {
  const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  const body = rows.filter(r => !/^[\s|:-]+$/.test(r));
  if (!body.length) return '';
  let html = '<table class="ntab">';
  body.forEach((r) => { html += '<tr>' + cells(r).map(c => `<td>${inlineMd(c)}</td>`).join('') + '</tr>'; });
  return html + '</table>';
}

/* --- 大纲文本：# 标题 / 缩进 / - 列表 / 1. 编号 --- */
function parseOutline(txt) {
  const lines = txt.replace(/\r\n?/g, '\n').split('\n');
  const useTab = lines.some(l => /^\t/.test(l));
  let unit = 2;
  if (!useTab) {
    const indents = lines.filter(l => l.trim())
      .map(l => (/^([ ]*)/.exec(l) || ['', ''])[1].length)
      .filter(n => n > 0);
    if (indents.length) unit = Math.min(Math.min(...indents), 8);
  }
  const BULLET = /^\s*(?:[-*+·•]|\d+[.)、]|[（(]\d+[）)]|[一二三四五六七八九十]+[、.])\s+/;

  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim()) { i++; continue; }
    if (/^\s*\|/.test(raw)) {                       // 表格块
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i].trim()); i++; }
      blocks.push({ type: 'table', rows });
      continue;
    }
    let level, text;
    const hm = /^(#{1,8})\s+(.*)$/.exec(raw);
    if (hm) { level = hm[1].length - 1; text = hm[2]; }
    else {
      const m = /^([ \t]*)(.*)$/.exec(raw);
      const ind = m[1];
      level = useTab ? ind.split('\t').length - 1 : Math.round(ind.length / unit);
      text = m[2];
    }
    text = text.replace(BULLET, '');
    blocks.push({ type: 'item', level, text: text.trim() });
    i++;
  }

  const items = blocks.filter(b => b.type === 'item');
  if (!items.length) throw new Error('没解析出任何节点（文本里要有层级或缩进）');
  const minLv = Math.min(...items.map(b => b.level));

  const tops = [];         // 所有 0 级（顶层）节点
  const stack = [];        // [{ lv, node }]，用来找当前的父节点
  const order = [];        // 出现顺序，供表格挂载
  let host4Table = null;
  for (const b of blocks) {
    if (b.type === 'item') {
      const lv = b.level - minLv;
      const node = newNode(inlineMd(b.text));
      if (lv === 0) {
        tops.push(node);
        stack.length = 0;                 // 换顶层节点，清空父级链
        stack.push({ lv: 0, node });
      } else {
        while (stack.length && stack[stack.length - 1].lv >= lv) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].node : tops[tops.length - 1];
        if (parent) parent.children.push(node);
        stack.push({ lv, node });
      }
      host4Table = node;
      order.push(node);
    } else {
      const html = tableToHtml(b.rows);
      if (html && host4Table) host4Table.content += html;
    }
  }
  /* 一份导图只能有一个根：多个顶层节点就自动包一层 */
  return tops.length === 1 ? tops[0] : mkNode('导入的导图', tops);
}

/* --- 文本类格式的统一入口（含嗅探） --- */
function parseTextFormat(txt, name) {
  const t = String(txt).trim();
  if (!t) throw new Error('文件是空的');
  if (/\.opml$/.test(name)) return parseOpml(t);
  if (/\.(mm|xml)$/.test(name)) {
    if (/<opml/i.test(t)) return parseOpml(t);
    if (/<xmap-content|<sheet[\s>]/i.test(t)) return parseXmindXml(t);
    return parseFreemind(t);
  }
  if (/^[{[]/.test(t)) {
    const o = JSON.parse(t);
    if (o && o.root) return o.root;
    throw new Error('JSON 里没有 root 字段（不是本工具导出的备份）');
  }
  if (/<opml/i.test(t)) return parseOpml(t);
  if (/<map[\s>]/i.test(t)) return parseFreemind(t);
  if (/<xmap-content|<sheet[\s>]/i.test(t)) return parseXmindXml(t);
  return parseOutline(t);
}

async function parseImportFile(file) {
  const name = (file.name || '').toLowerCase();
  if (/\.(xmind|pos|km|mmap)$/.test(name)) {
    const zip = await readZip(await file.arrayBuffer());
    return parseFromZip(zip);
  }
  const txt = await file.text();
  return parseTextFormat(txt, name);
}

/* 压缩包内部嗅探：.xmind 两种版本 + WPS .pos 兜底 */
function parseFromZip(zip) {
  const tries = [];
  if (zip.text['content.json']) tries.push(() => parseXmindJson(zip.text['content.json'], zip));
  if (zip.text['content.xml'])  tries.push(() => parseXmindXml(zip.text['content.xml']));
  for (const [name, txt] of Object.entries(zip.text)) {
    if (!/\.(json|xml)$/i.test(name)) continue;
    if (/rootTopic/.test(txt))        tries.push(() => parseXmindJson(txt, zip));
    if (/<xmap-content|<sheet[\s>]/.test(txt)) tries.push(() => parseXmindXml(txt));
    if (/<map[\s>]/.test(txt))        tries.push(() => parseFreemind(txt));
    if (/<opml/i.test(txt))           tries.push(() => parseOpml(txt));
  }
  let lastErr = null;
  for (const fn of tries) { try { return fn(); } catch (e) { lastErr = e; } }
  throw new Error('认不出这个压缩包里的导图格式' + (lastErr ? '（' + lastErr.message + '）' : '') +
                  '，建议在原软件里导出成 .mm 或 .txt 再导入');
}

/* =========================================================================
 * 导入：界面
 * ========================================================================= */
const importModal = document.getElementById('importModal');
const importFileEl = document.getElementById('importFile');
const dropZone = document.getElementById('dropZone');
const dzFile = document.getElementById('dzFile');
const impTextEl = document.getElementById('impText');
let impTab = 'file';
let pendingFile = null;

function openImport() { importModal.classList.remove('hidden'); }
function closeImport() { importModal.classList.add('hidden'); }

importModal.addEventListener('click', (e) => {
  const tab = e.target.dataset.impTab;
  if (tab) {
    impTab = tab;
    importModal.querySelectorAll('.imp-tab').forEach(b => b.classList.toggle('on', b.dataset.impTab === tab));
    document.getElementById('impPaneFile').classList.toggle('hidden', tab !== 'file');
    document.getElementById('impPanePaste').classList.toggle('hidden', tab !== 'paste');
    return;
  }
  if (e.target === importModal) closeImport();
});
function setPendingFile(f) {
  pendingFile = f;
  dzFile.textContent = '已选择：' + f.name;
  dzFile.classList.add('has');
}
dropZone.addEventListener('click', () => importFileEl.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dropZone.classList.remove('over');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) setPendingFile(f);
});
importFileEl.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) setPendingFile(f); });
document.getElementById('impClose').addEventListener('click', closeImport);
document.getElementById('impReplace').addEventListener('click', () => runImport('replace'));
document.getElementById('impInsert').addEventListener('click', () => runImport('insert'));

async function runImport(mode) {
  let imported = null;
  try {
    if (impTab === 'file') {
      if (!pendingFile) { toast('先选一个文件'); return; }
      imported = await parseImportFile(pendingFile);
    } else {
      const t = impTextEl.value.trim();
      if (!t) { toast('先粘贴大纲文本'); return; }
      imported = parseTextFormat(t, 'pasted.txt');
    }
  } catch (err) { toast('导入失败：' + err.message); return; }
  if (!imported) { toast('没解析出任何节点'); return; }

  const count = collect(imported).length;
  if (mode === 'replace') {
    if (!confirm(`将用导入的 ${count} 个节点替换当前整张导图，继续？`)) return;
    root = imported;
  } else {
    const host = selectedId ? findNode(root, selectedId) : root;
    if (!host) { toast('找不到插入位置'); return; }
    host.collapsed = false;
    host.children.push(imported);
  }
  selectedId = null;
  render(); autosave(); fitView();
  closeImport();
  toast(`导入成功：${count} 个节点`);
}

/* =========================================================================
 * 导出 PNG —— SVG foreignObject + canvas，零第三方库
 * ========================================================================= */
const pngModal = document.getElementById('pngModal');
let pngOpt = { scale: 2, bg: 'dark' };

function openPngModal() { pngModal.classList.remove('hidden'); }
pngModal.addEventListener('click', (e) => {
  const seg = e.target.closest ? e.target.closest('.seg') : null;
  if (seg && e.target.dataset.v) {
    if (seg.id === 'pngScale') pngOpt.scale = +e.target.dataset.v;
    else pngOpt.bg = e.target.dataset.v;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target));
    return;
  }
  if (e.target === pngModal) pngModal.classList.add('hidden');
});
document.getElementById('pngClose').addEventListener('click', () => pngModal.classList.add('hidden'));
document.getElementById('pngGo').addEventListener('click', async () => {
  pngModal.classList.add('hidden');
  toast('正在生成图片…', 4000);
  try { await exportPng(pngOpt.scale, pngOpt.bg); }
  catch (err) { toast('导出失败：' + err.message); }
});

/* 需要随克隆一起带走的 CSS 属性（外部样式表在导出时读不到，所以要内联） */
const EXP_PROPS = [
  'position', 'display', 'box-sizing', 'width', 'height', 'min-width', 'max-width',
  'min-height', 'max-height', 'margin', 'padding', 'border', 'border-radius',
  'background-color', 'background-image', 'color', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-decoration', 'text-align', 'line-height',
  'opacity', 'box-shadow', 'vertical-align', 'overflow', 'white-space'
];
function inlineComputed(src, dst) {
  const cs = getComputedStyle(src);
  let css = '';
  for (const p of EXP_PROPS) { const v = cs.getPropertyValue(p); if (v) css += p + ':' + v + ';'; }
  dst.style.cssText += css;
  const sc = src.children, dc = dst.children;
  for (let i = 0; i < sc.length && i < dc.length; i++) inlineComputed(sc[i], dc[i]);
}
async function toDataUrlOf(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取图片失败'));
    r.readAsDataURL(blob);
  });
}

async function exportPng(mult, bgMode) {
  const vis = collect(root).filter(n => !n._hidden);
  if (!vis.length) { toast('没有可导出的节点'); return; }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of vis) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  const PAD = 40;
  const W = Math.ceil(maxX - minX + PAD * 2);
  const H = Math.ceil(maxY - minY + PAD * 2);

  /* 1) 容器 */
  const box = document.createElement('div');
  box.style.position = 'relative';
  box.style.width = W + 'px';
  box.style.height = H + 'px';
  box.style.background = bgMode === 'white' ? '#ffffff' : (bgMode === 'none' ? 'transparent' : '#0f1115');
  box.style.fontFamily = '"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  box.style.color = '#e6e9ef';

  /* 2) 连线（CSS 选择器在这里不生效，所以描边直接写成属性） */
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `${minX - PAD} ${minY - PAD} ${W} ${H}`);
  svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;';
  for (const p of edgesSvg.querySelectorAll('path.edge')) {
    const c = p.cloneNode(true);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', '#3a4250');
    c.setAttribute('stroke-width', '2');
    svg.appendChild(c);
  }
  box.appendChild(svg);

  /* 3) 节点（内联计算样式，保证导出后长得跟屏幕上一模一样） */
  for (const n of vis) {
    const c = n._el.cloneNode(true);
    c.removeAttribute('contenteditable');
    c.classList.remove('selected', 'dragging', 'drop-target');
    c.querySelectorAll('.toggle, .grip').forEach(x => x.remove());
    c.style.display = '';
    inlineComputed(n._el, c);
    c.style.transition = 'none';
    c.style.left = (n.x - minX + PAD) + 'px';
    c.style.top = (n.y - minY + PAD) + 'px';
    c.style.width = n.w + 'px';
    box.appendChild(c);
  }

  /* 4) 图片转 dataURL（外链图会污染 canvas，导致无法导出） */
  for (const img of [...box.querySelectorAll('img')]) {
    const s = img.getAttribute('src') || '';
    if (/^data:/i.test(s)) continue;
    try { img.setAttribute('src', await toDataUrlOf(s)); }
    catch (e) { img.remove(); }
  }

  /* 5) 序列化 → SVG → canvas → PNG */
  const xhtml = new XMLSerializer().serializeToString(box);
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
               + `<foreignObject x="0" y="0" width="100%" height="100%">`
               + `<div xmlns="http://www.w3.org/1999/xhtml">${xhtml}</div>`
               + `</foreignObject></svg>`;
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('图片渲染失败'));
      img.src = url;
    });
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * mult); cv.height = Math.round(H * mult);
    const ctx = cv.getContext('2d');
    if (bgMode !== 'none') {
      ctx.fillStyle = bgMode === 'white' ? '#ffffff' : '#0f1115';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
    ctx.setTransform(mult, 0, 0, mult, 0, 0);
    ctx.drawImage(img, 0, 0, W, H);
    const a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    a.download = 'mindnotes.png';
    a.click();
    toast(`已导出 PNG（${cv.width}×${cv.height}）`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* =========================================================================
 * 账号系统（本地存储 · 不依赖后端）
 * - 密码 SHA-256 哈希 + 盐，存到 localStorage（不在网络上传输）
 * - 每个账号独立工作区 localStorage 槽位 + 云端目录（notes/<user>/, assets/<user>/）
 * - 跨设备同步：每个账号在云端用自己的子目录，互不干扰
 * ========================================================================= */
function _loadUsers() { try { return JSON.parse(localStorage.getItem(LS_USERS) || '{}'); } catch (e) { return {}; } }
function _saveUsers(u) { localStorage.setItem(LS_USERS, JSON.stringify(u)); }
async function _hash(pwd, salt) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(salt + ':' + pwd));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function _newSalt() {
  const a = new Uint8Array(8); crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}
function _isValidUsername(u) { return typeof u === 'string' && /^[a-zA-Z0-9_\-.\u4e00-\u9fa5]{2,32}$/.test(u); }
async function registerUser(username, password) {
  username = (username || '').trim();
  if (!_isValidUsername(username)) throw new Error('用户名需 2-32 字符（字母/数字/_-.·或中文）');
  if ((password || '').length < 4) throw new Error('密码至少 4 个字符');
  const users = _loadUsers();
  if (users[username]) throw new Error('该账号已存在');
  const salt = _newSalt();
  const hash = await _hash(password, salt);
  users[username] = { salt, hash, createdAt: Date.now() };
  _saveUsers(users);
  return username;
}
async function loginUser(username, password) {
  username = (username || '').trim();
  const users = _loadUsers();
  const rec = users[username];
  if (!rec) throw new Error('账号不存在');
  const hash = await _hash(password, rec.salt);
  if (hash !== rec.hash) throw new Error('密码错误');
  return username;
}
function logoutUser() {
  currentUser = null;
  localStorage.removeItem(LS_SESSION);
}
function getSession() {
  try { return JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch (e) { return null; }
}
function setSession(username) {
  currentUser = username;
  localStorage.setItem(LS_SESSION, JSON.stringify({ username, loginAt: Date.now() }));
}

function showAuthModal() {
  const m = document.getElementById('authModal');
  if (m) m.classList.remove('hidden');
  const u = document.getElementById('authUser'); if (u) { u.value = ''; setTimeout(() => u.focus(), 30); }
  const p = document.getElementById('authPass'); if (p) p.value = '';
  document.getElementById('authErr').textContent = '';
  document.getElementById('authPaneLogin').classList.remove('hidden');
  document.getElementById('authPaneRegister').classList.add('hidden');
  document.getElementById('authUserList').innerHTML = renderLocalUserList();
}
function hideAuthModal() {
  const m = document.getElementById('authModal');
  if (m) m.classList.add('hidden');
}
function renderLocalUserList() {
  const users = _loadUsers();
  const names = Object.keys(users);
  if (!names.length) return '<div class="muted small" style="padding:6px 4px">还没有任何账号</div>';
  return names.map(n => `<div class="auth-user-row" data-user="${escapeHtml(n)}">👤 ${escapeHtml(n)}<button data-action="login" title="登录此账号">→</button></div>`).join('');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function doLogin(username, password) {
  try {
    const u = await loginUser(username, password);
    setSession(u);
    hideAuthModal();
    /* 登录成功 → 触发主程序 boot */
    enterApp();
  } catch (e) { document.getElementById('authErr').textContent = '✗ ' + e.message; }
}
async function doRegister(username, password, password2) {
  if (password !== password2) { document.getElementById('authErr').textContent = '✗ 两次输入的密码不一致'; return; }
  try {
    const u = await registerUser(username, password);
    /* 注册成功后直接登录 */
    await loginUser(username, password);
    setSession(u);
    hideAuthModal();
    enterApp();
  } catch (e) { document.getElementById('authErr').textContent = '✗ ' + e.message; }
}
function doLogout() {
  if (!confirm('确定要登出当前账号？\n当前账号的笔记会保留在本机和云端，重新登录后可见。')) return;
  logoutUser();
  /* 清空内存中的工作区，强制回登录界面 */
  notes = {}; noteOrder = []; currentNoteId = null; root = null; selectedId = null;
  const u = document.getElementById('currentUser'); if (u) u.textContent = '';
  const lo = document.getElementById('authLogout'); if (lo) lo.classList.add('hidden');
  try { render(); renderNoteList(); } catch (e) {}
  showAuthModal();
}

function wireAuthUI() {
  document.getElementById('authSwitchReg').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('authPaneLogin').classList.add('hidden');
    document.getElementById('authPaneRegister').classList.remove('hidden');
    document.getElementById('authErr').textContent = '';
    const u = document.getElementById('authUserR'); if (u) { u.value = ''; setTimeout(() => u.focus(), 30); }
    const p = document.getElementById('authPassR'); if (p) p.value = '';
    const p2 = document.getElementById('authPassR2'); if (p2) p2.value = '';
  });
  document.getElementById('authSwitchLogin').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('authPaneLogin').classList.remove('hidden');
    document.getElementById('authPaneRegister').classList.add('hidden');
    document.getElementById('authErr').textContent = '';
  });
  document.getElementById('authLoginBtn').addEventListener('click', () => {
    const u = document.getElementById('authUser').value;
    const p = document.getElementById('authPass').value;
    doLogin(u, p);
  });
  document.getElementById('authRegBtn').addEventListener('click', () => {
    const u = document.getElementById('authUserR').value;
    const p = document.getElementById('authPassR').value;
    const p2 = document.getElementById('authPassR2').value;
    doRegister(u, p, p2);
  });
  document.getElementById('authLogout').addEventListener('click', doLogout);
  /* 列表点用户名回填，点 → 直接登录（要求再输密码） */
  document.getElementById('authUserList').addEventListener('click', (e) => {
    const row = e.target.closest('.auth-user-row');
    if (!row) return;
    const u = row.getAttribute('data-user');
    document.getElementById('authUser').value = u;
    document.getElementById('authPass').focus();
  });
  /* Enter 提交 */
  ['authUser', 'authPass'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('authLoginBtn').click(); }
    });
  });
  ['authUserR', 'authPassR', 'authPassR2'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('authRegBtn').click(); }
    });
  });
  /* Esc 关闭（如果已登录才能关） */
  document.getElementById('authModal').addEventListener('click', (e) => {
    if (e.target.id === 'authModal' && currentUser) hideAuthModal();
  });
}

/* ---------------- 启动 ---------------- */
function seed() {
  const r = newNode('📚 我的学习笔记');
  const a = newNode('🧮 数学');
  a.children = [
    newNode('代数<div>方程与函数</div>'),
    newNode('几何<table class="ntab"><tr><td>图形</td><td>公式</td></tr><tr><td>圆</td><td>πr²</td></tr></table>')
  ];
  const b = newNode('💡 灵感收集');
  r.children = [a, b];
  return r;
}
loadConfig();
wireAuthUI();
/* 完全首登：未登录时拦住主界面 */
const _session = getSession();
if (_session && _loadUsers()[_session.username]) {
  currentUser = _session.username;
  enterApp();
} else {
  /* 清理过期 session（指向已删除的账号） */
  if (_session) localStorage.removeItem(LS_SESSION);
  showAuthModal();
}

/* 登录后真正进入主程序 */
async function enterApp() {
  /* 兼容迁移：旧版 mindnotes_workspace 升级时把第一个用户迁过去 */
  migrateOldWorkspace();
  /* 工具栏显示当前用户 + 登出按钮 */
  const u = document.getElementById('currentUser');
  if (u) u.textContent = '👤 ' + currentUser;
  const lo = document.getElementById('authLogout');
  if (lo) lo.classList.remove('hidden');
  let ok = false;
  if (configured()) {
    try { await loadWorkspaceFromGithub(); ok = true; } catch (e) { ok = false; }
  }
  if (!ok) {
    if (!loadLocalWorkspace()) {
      const old = migrateOldLocalForUser();
      if (old) { const id = newId(); notes[id] = old; noteOrder = [id]; currentNoteId = id; }
      else initDefaultWorkspace();
    }
  }
  root = notes[currentNoteId].root;
  render(); fitView(); selectNode(root.id);
  renderNoteList();
  historyReset();
}

/* 旧版 mindnotes_workspace（无账号）→ 第一个本地账号的工作区 */
function migrateOldWorkspace() {
  if (!currentUser) return;
  if (localStorage.getItem(workspaceKey(currentUser))) return;   // 目标已有数据
  const old = localStorage.getItem(LS_WORKSPACE);
  if (!old) return;
  localStorage.setItem(workspaceKey(currentUser), old);
  /* 不删除旧 key，保留给后续登入的账号可能用得上 + 安全起见不丢数据 */
}
/* 旧 mindnotes_local 兼容迁移：现在每个账号的命名空间独立，从 login 用户加载 */
function migrateOldLocalForUser() {
  /* migrateOldLocal 是从旧的 mindnotes_local 读（无账号概念），现在已无意义，留 stub */
  return null;
}

/* 侧边栏交互：新建笔记 / 搜索过滤 */
const _btnNewNote = document.getElementById('btnNewNote');
if (_btnNewNote) _btnNewNote.addEventListener('click', () => createNote());
const _noteSearch = document.getElementById('noteSearch');
if (_noteSearch) _noteSearch.addEventListener('input', renderNoteList);

/* 跨笔记搜索的输入框 / 结果区 / 弹窗点击 / Esc 关闭 等都集中在这里 */
wireSearch();
