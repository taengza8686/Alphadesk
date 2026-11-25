// AlphaDesk 노트 편집기 (Notion 스타일) — TipTap 기반, 빌드 결과: site/vendor/note-editor.js
import { Editor, Extension, Node, mergeAttributes, InputRule, wrappingInputRule } from '@tiptap/core';
import Blockquote from '@tiptap/extension-blockquote';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Slice, Fragment } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color, BackgroundColor } from '@tiptap/extension-text-style';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Details, DetailsSummary, DetailsContent } from '@tiptap/extension-details';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import Suggestion from '@tiptap/suggestion';
import { PluginKey, Plugin } from '@tiptap/pm/state';

export const TEXT_COLORS = [['기본', null], ['회색', '#9b9a97'], ['갈색', '#ba856f'], ['주황', '#d9730d'], ['노랑', '#cb912f'], ['초록', '#4dab9a'], ['파랑', '#529cca'], ['보라', '#9a6dd7'], ['분홍', '#e255a1'], ['빨강', '#e03e3e']];
export const BG_COLORS = [['기본', null], ['회색', 'rgba(155,154,151,0.22)'], ['갈색', 'rgba(186,133,111,0.25)'], ['주황', 'rgba(217,115,13,0.25)'], ['노랑', 'rgba(223,171,1,0.25)'], ['초록', 'rgba(77,171,154,0.25)'], ['파랑', 'rgba(82,156,202,0.25)'], ['보라', 'rgba(154,109,215,0.25)'], ['분홍', 'rgba(226,85,161,0.25)'], ['빨강', 'rgba(224,62,62,0.25)']];

// 콜아웃 블록 (아이콘 + 배경 박스)
const Callout = Node.create({
  name: 'callout', group: 'block', content: 'block+', defining: true,
  addAttributes() { return { icon: { default: '💡', parseHTML: el => el.getAttribute('data-icon') || '💡', renderHTML: a => ({ 'data-icon': a.icon }) } }; },
  parseHTML() { return [{ tag: 'div[data-callout]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes({ 'data-callout': '' }, HTMLAttributes), 0]; },
});

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BLOCKS = [
  { k: 'text', t: '텍스트', d: '일반 문단', i: 'Aa', run: c => c.setParagraph() },
  { k: 'h1 heading 제목1', t: '제목 1', d: '큰 제목', i: 'H1', run: c => c.setHeading({ level: 1 }) },
  { k: 'h2 heading 제목2', t: '제목 2', d: '중간 제목', i: 'H2', run: c => c.setHeading({ level: 2 }) },
  { k: 'h3 heading 제목3', t: '제목 3', d: '작은 제목', i: 'H3', run: c => c.setHeading({ level: 3 }) },
  { k: 'bullet list 글머리 목록', t: '글머리 기호 목록', d: '• 목록', i: '•', run: c => c.toggleBulletList() },
  { k: 'number ordered list 번호 목록', t: '번호 매기기 목록', d: '1. 목록', i: '1.', run: c => c.toggleOrderedList() },
  { k: 'todo task check 할일 체크', t: '할 일 목록', d: '체크박스', i: '☑', run: c => c.toggleTaskList() },
  { k: 'toggle details 토글', t: '토글 목록', d: '접었다 펼치는 블록', i: '▸', run: c => c.setDetails() },
  { k: 'quote 인용', t: '인용', d: '인용문', i: '❝', run: c => c.setBlockquote() },
  { k: 'callout 콜아웃', t: '콜아웃', d: '강조 박스', i: '💡', run: c => c.wrapIn('callout') },
  { k: 'divider hr 구분선', t: '구분선', d: '가로줄', i: '—', run: c => c.setHorizontalRule() },
  { k: 'table 표', t: '표', d: '3×3 표', i: '▦', run: c => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { k: 'code 코드', t: '코드', d: '코드 블록', i: '</>', run: c => c.setCodeBlock() },
  { k: 'image 이미지 사진', t: '이미지', d: '파일 올리기', i: '🖼', image: true },
];

function makeSlash(getUpload) {
  return Extension.create({
    name: 'slashMenu',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [Suggestion({
        editor, char: '/', pluginKey: new PluginKey('slash'), startOfLine: false, allowSpaces: false,
        items: ({ query }) => { const q = query.toLowerCase(); return BLOCKS.filter(b => !q || b.k.includes(q) || b.t.includes(q)).slice(0, 14); },
        command: ({ editor, range, props }) => {
          const ch = editor.chain().focus().deleteRange(range);
          if (props.image) { ch.run(); pickImage(editor, getUpload()); return; }
          props.run(ch).run();
        },
        render: () => {
          let el, items = [], idx = 0, cmd;
          const draw = () => {
            el.innerHTML = items.length ? items.map((b, i) => `<button type="button" data-i="${i}" class="ne-mi${i === idx ? ' on' : ''}"><span class="ne-ic">${esc(b.i)}</span><span><b>${esc(b.t)}</b><small>${esc(b.d)}</small></span></button>`).join('') : '<div class="ne-empty">결과 없음</div>';
            const on = el.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
          };
          const place = r => { const rect = r.clientRect?.(); if (!rect) return; el.style.left = Math.min(rect.left, innerWidth - 270) + 'px'; el.style.top = (rect.bottom + 6 + 300 > innerHeight ? Math.max(8, rect.top - 306) : rect.bottom + 6) + 'px'; };
          return {
            onStart: p => { items = p.items; idx = 0; cmd = p.command; el = document.createElement('div'); el.className = 'ne-menu'; el.addEventListener('mousedown', e => { e.preventDefault(); const b = e.target.closest('[data-i]'); if (b) cmd(items[+b.dataset.i]); }); document.body.appendChild(el); draw(); place(p); },
            onUpdate: p => { items = p.items; idx = 0; cmd = p.command; draw(); place(p); },
            onKeyDown: ({ event }) => {
              if (event.key === 'ArrowDown') { idx = (idx + 1) % Math.max(1, items.length); draw(); return true; }
              if (event.key === 'ArrowUp') { idx = (idx - 1 + items.length) % Math.max(1, items.length); draw(); return true; }
              if (event.key === 'Enter') { if (items[idx]) { cmd(items[idx]); return true; } return false; }
              if (event.key === 'Escape') { el?.remove(); el = null; return true; }
              return false;
            },
            onExit: () => { el?.remove(); el = null; },
          };
        },
      })];
    },
  });
}

async function compressImage(file) {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type) || file.size < 400000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch (e) { return file; }
}
async function uploadAndInsert(editor, upload, files, pos) {
  for (const f0 of files) {
    if (!/^image\//.test(f0.type)) continue;
    const f = await compressImage(f0);
    try {
      const url = await upload(f);
      if (!url) continue;
      const ch = editor.chain().focus();
      (pos != null ? ch.insertContentAt(pos, { type: 'image', attrs: { src: url } }) : ch.setImage({ src: url })).run();
    } catch (e) { alert('이미지 업로드 실패: ' + (e.message || e)); }
  }
}
function pickImage(editor, upload) {
  if (!upload) return;
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => uploadAndInsert(editor, upload, [...inp.files]);
  inp.click();
}

// 선택 영역 서식 툴바 (굵게·기울임·밑줄·취소선·코드·링크·글자색·배경색)
function makeBubble(editor) {
  const el = document.createElement('div'); el.className = 'ne-bubble'; el.style.display = 'none';
  const btn = (a, label, title) => `<button type="button" data-a="${a}" title="${title}">${label}</button>`;
  el.innerHTML = btn('bold', '<b>B</b>', '굵게 (Ctrl+B)') + btn('italic', '<i>I</i>', '기울임 (Ctrl+I)') + btn('underline', '<u>U</u>', '밑줄 (Ctrl+U)') + btn('strike', '<s>S</s>', '취소선') + btn('code', '&lt;/&gt;', '코드') + btn('link', '🔗', '링크 (Ctrl+K)')
    + '<span class="ne-sep"></span>' + btn('color', 'A<span style="font-size:9px">▾</span>', '글자색·배경색')
    + `<div class="ne-pal" style="display:none"><div class="ne-pl">글자색</div>${TEXT_COLORS.map(([n, c]) => `<button type="button" data-tc="${c || ''}" title="${n}"><span style="color:${c || 'inherit'}">A</span></button>`).join('')}<div class="ne-pl">배경색</div>${BG_COLORS.map(([n, c]) => `<button type="button" data-bc="${c || ''}" title="${n}"><span style="background:${c || 'transparent'};border:1px solid #475569">A</span></button>`).join('')}</div>`;
  document.body.appendChild(el);
  const pal = el.querySelector('.ne-pal');
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    const b = e.target.closest('button'); if (!b) return;
    const c = editor.chain().focus();
    if (b.dataset.a === 'bold') c.toggleBold().run();
    else if (b.dataset.a === 'italic') c.toggleItalic().run();
    else if (b.dataset.a === 'underline') c.toggleUnderline().run();
    else if (b.dataset.a === 'strike') c.toggleStrike().run();
    else if (b.dataset.a === 'code') c.toggleCode().run();
    else if (b.dataset.a === 'link') setLink(editor);
    else if (b.dataset.a === 'color') pal.style.display = pal.style.display === 'none' ? 'grid' : 'none';
    else if (b.dataset.tc !== undefined) (b.dataset.tc ? c.setColor(b.dataset.tc) : c.unsetColor()).run();
    else if (b.dataset.bc !== undefined) (b.dataset.bc ? c.setBackgroundColor(b.dataset.bc) : c.unsetBackgroundColor()).run();
    upd();
  });
  const upd = () => {
    const { from, to, empty } = editor.state.selection;
    if (empty || !editor.isEditable || !editor.isFocused || editor.isActive('image') || editor._ptrDown) { el.style.display = 'none'; pal.style.display = 'none'; return; }
    const a = editor.view.coordsAtPos(from), b = editor.view.coordsAtPos(to);
    el.style.display = 'block';
    const w = el.offsetWidth;
    el.style.left = Math.max(8, Math.min((a.left + b.left) / 2 - w / 2, innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, a.top - el.offsetHeight - 8) + 'px';
    ['bold', 'italic', 'underline', 'strike', 'code', 'link'].forEach(k => el.querySelector(`[data-a="${k}"]`).classList.toggle('on', editor.isActive(k)));
  };
  editor.on('selectionUpdate', upd); editor.on('blur', () => setTimeout(upd, 150)); editor.on('focus', upd); editor.on('pointer-up', () => setTimeout(upd, 0));
  const onScroll = () => { if (el.style.display !== 'none') upd(); };
  addEventListener('scroll', onScroll, true);
  return () => { el.remove(); removeEventListener('scroll', onScroll, true); };
}
function setLink(editor) {
  const prev = editor.getAttributes('link').href || '';
  const url = prompt('링크 주소 (비우면 링크 해제)', prev);
  if (url === null) return;
  if (!url.trim()) editor.chain().focus().extendMarkRange('link').unsetLink().run();
  else editor.chain().focus().extendMarkRange('link').setLink({ href: /^(https?:|mailto:|#|\/)/i.test(url.trim()) ? url.trim() : 'https://' + url.trim() }).run();
}

// 표 안에 있을 때 나오는 표 도구
function makeTableBar(editor) {
  const el = document.createElement('div'); el.className = 'ne-bubble ne-tbar'; el.style.display = 'none';
  const A = [['addRowAfter', '+행'], ['addColumnAfter', '+열'], ['deleteRow', '−행'], ['deleteColumn', '−열'], ['toggleHeaderRow', '머리행'], ['deleteTable', '표 삭제']];
  el.innerHTML = A.map(([a, l]) => `<button type="button" data-t="${a}">${l}</button>`).join('');
  document.body.appendChild(el);
  el.addEventListener('mousedown', e => { e.preventDefault(); const b = e.target.closest('[data-t]'); if (b) editor.chain().focus()[b.dataset.t]().run(); upd(); });
  const upd = () => {
    if (!editor.isEditable || !editor.isActive('table') || !editor.isFocused || editor._ptrDown) { el.style.display = 'none'; return; }
    let dom = editor.view.domAtPos(editor.state.selection.from).node; while (dom && dom.nodeName !== 'TABLE') dom = dom.parentNode;
    if (!dom) { el.style.display = 'none'; return; }
    const r = dom.getBoundingClientRect(); el.style.display = 'block';
    el.style.left = Math.max(8, r.left) + 'px'; el.style.top = Math.max(8, r.top - el.offsetHeight - 6) + 'px';
  };
  editor.on('selectionUpdate', upd); editor.on('blur', () => setTimeout(upd, 150)); editor.on('focus', upd); editor.on('pointer-up', () => setTimeout(upd, 0));
  const onScroll = () => { if (el.style.display !== 'none') upd(); };
  addEventListener('scroll', onScroll, true);
  return () => { el.remove(); removeEventListener('scroll', onScroll, true); };
}

const Keys = Extension.create({
  name: 'adKeys',
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => { setLink(this.editor); return true; },
      'Mod-s': () => { this.editor.emit('save-now'); return true; },
    };
  },
});


// ------------------------------------------------------------------ Notion식 블록 조작 (줄 추가·삭제·이동·복제·들여쓰기)
const LIST_ITEMS = ['listItem', 'taskItem'];
const INDENTABLE = ['paragraph', 'heading', 'details', 'callout', 'codeBlock', 'blockquote', 'image', 'table', 'horizontalRule'];
const INDENT_ATTR_TYPES = [...INDENTABLE, 'bulletList', 'orderedList', 'taskList'];
const MAX_INDENT = 8;

// 위치(pos)가 속한 "한 줄(블록)" 찾기: 목록 줄 → 표 → 토글 → 문단·제목
function blockAt(doc, pos) {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'table') return { pos: $p.before(d), node: $p.node(d) };
  for (let d = $p.depth; d > 0; d--) if (LIST_ITEMS.includes($p.node(d).type.name)) return { pos: $p.before(d), node: $p.node(d) };
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.type.name === 'detailsSummary' || n.type.name === 'detailsContent') { if (n.type.name === 'detailsSummary') return { pos: $p.before(d - 1), node: $p.node(d - 1) }; continue; }
    if (n.isTextblock || n.isAtom) return { pos: $p.before(d), node: n };
  }
  const after = $p.nodeAfter; if (after && after.isBlock) return { pos: $p.pos, node: after };
  return null;
}
function curBlock(state) { const { selection } = state; if (selection instanceof NodeSelection) return { pos: selection.from, node: selection.node }; return blockAt(state.doc, selection.from); }
function emptyLike(schema, node) {
  if (node.type.name === 'taskItem') return schema.nodes.taskItem.create({ checked: false }, schema.nodes.paragraph.create());
  if (node.type.name === 'listItem') return schema.nodes.listItem.create(null, schema.nodes.paragraph.create());
  return schema.nodes.paragraph.create({ indent: node.attrs?.indent || 0 });
}
function addBelow(editor, blk, slash) {
  const { state, view } = editor; const node = blk.node; const end = blk.pos + node.nodeSize;
  const nn = emptyLike(state.schema, node);
  const tr = state.tr.insert(end, nn);
  tr.setSelection(TextSelection.near(tr.doc.resolve(end + (LIST_ITEMS.includes(node.type.name) ? 2 : 1))));
  view.dispatch(tr.scrollIntoView()); view.focus();
  if (slash) editor.commands.insertContent('/');
}
function deleteBlock(editor, blk) {
  const { state, view } = editor; const $p = state.doc.resolve(blk.pos);
  let from = blk.pos, to = blk.pos + blk.node.nodeSize;
  if (LIST_ITEMS.includes(blk.node.type.name) && $p.parent.childCount === 1) { from = $p.before($p.depth); to = $p.after($p.depth); }
  const tr = state.tr.delete(from, to);
  if (tr.doc.content.size === 0 || tr.doc.childCount === 0) tr.insert(0, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), -1));
  view.dispatch(tr); view.focus();
}
function duplicateBlock(editor, blk) {
  const { state, view } = editor; const end = blk.pos + blk.node.nodeSize;
  const tr = state.tr.insert(end, blk.node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1))); view.dispatch(tr.scrollIntoView()); view.focus();
}
function moveBlock(editor, blk, dir) {
  const { state, view } = editor; const $p = state.doc.resolve(blk.pos); const idx = $p.index(); const parent = $p.parent;
  const sib = dir < 0 ? (idx > 0 ? parent.child(idx - 1) : null) : (idx < parent.childCount - 1 ? parent.child(idx + 1) : null);
  if (!sib) return false;
  const size = blk.node.nodeSize; const tr = state.tr;
  const off = state.selection.from - blk.pos;
  tr.delete(blk.pos, blk.pos + size);
  const at = dir < 0 ? blk.pos - sib.nodeSize : blk.pos + sib.nodeSize;
  tr.insert(at, blk.node);
  const inside = off >= 0 && off < size;
  tr.setSelection(inside ? TextSelection.near(tr.doc.resolve(at + off)) : NodeSelection.create(tr.doc, at));
  view.dispatch(tr.scrollIntoView()); return true;
}
function setIndent(editor, delta) {
  const { state, view } = editor; const { from, to } = state.selection; const tr = state.tr; let changed = false;
  const seen = new Set();
  const apply = (pos, node) => {
    if (seen.has(pos) || !INDENTABLE.includes(node.type.name) || !('indent' in node.attrs)) return;
    seen.add(pos);
    const v = Math.max(0, Math.min(MAX_INDENT, (node.attrs.indent || 0) + delta));
    if (v !== node.attrs.indent) { tr.setNodeMarkup(pos, null, { ...node.attrs, indent: v }); changed = true; }
  };
  if (state.selection instanceof NodeSelection) apply(from, state.selection.node);
  else state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (LIST_ITEMS.includes(node.type.name) || node.type.name === 'table') return false;
    if (node.type.name === 'details') { apply(pos, node); return false; }
    if (node.isTextblock) { const b = blockAt(state.doc, pos + 1); if (b) apply(b.pos, b.node); return false; }
    if (node.isAtom) apply(pos, node);
  });
  if (changed) view.dispatch(tr);
  return true;
}
function inListItem(state) { const $f = state.selection.$from; for (let d = $f.depth; d > 0; d--) if (LIST_ITEMS.includes($f.node(d).type.name)) return $f.node(d).type.name; return null; }
function tabKey(editor, dir) {
  const { state } = editor;
  if (editor.isActive('table')) return false;                     // 표: 칸 이동은 표 기능에 맡김
  if (editor.isActive('codeBlock') && dir > 0) { editor.commands.insertContent('  '); return true; }
  const li = inListItem(state);
  if (li) { if (dir > 0) editor.commands.sinkListItem(li); else editor.commands.liftListItem(li); return true; }
  return setIndent(editor, dir);
}
function turnInto(editor, blk, kind) {
  const { state, view } = editor;
  const inner = blk.pos + 1 + (LIST_ITEMS.includes(blk.node.type.name) ? 1 : 0);
  view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(inner))));
  const c = () => editor.chain().focus();
  const li = inListItem(editor.state);
  if (li && !['bullet', 'ordered', 'task'].includes(kind)) { let g = 0; while (inListItem(editor.state) && g++ < 6) editor.commands.liftListItem(inListItem(editor.state)); }
  const map = {
    text: () => c().setParagraph().run(), h1: () => c().setHeading({ level: 1 }).run(), h2: () => c().setHeading({ level: 2 }).run(), h3: () => c().setHeading({ level: 3 }).run(),
    bullet: () => editor.isActive('bulletList') ? true : c().toggleBulletList().run(), ordered: () => editor.isActive('orderedList') ? true : c().toggleOrderedList().run(),
    task: () => editor.isActive('taskList') ? true : c().toggleTaskList().run(), toggle: () => c().setDetails().run(), quote: () => c().setBlockquote().run(),
    callout: () => c().wrapIn('callout').run(), code: () => c().setCodeBlock().run(),
  };
  (map[kind] || (() => {}))();
}
function colorBlock(editor, blk, attr, color) {
  const { state, view } = editor;
  const from = blk.pos + 1, to = blk.pos + blk.node.nodeSize - 1;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  const c = editor.chain().focus();
  if (attr === 'color') (color ? c.setColor(color) : c.unsetColor()).run(); else (color ? c.setBackgroundColor(color) : c.unsetBackgroundColor()).run();
  view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, Math.min(to, editor.state.doc.content.size))));
}

const Indent = Extension.create({
  name: 'adIndent', priority: 1000,
  addGlobalAttributes() {
    return [{ types: INDENT_ATTR_TYPES, attributes: { indent: {
      default: 0, keepOnSplit: true,
      parseHTML: el => { const v = parseInt(el.getAttribute('data-indent') || '0', 10); return v > 0 ? Math.min(MAX_INDENT, v) : 0; },
      renderHTML: a => a.indent ? { 'data-indent': a.indent, style: `--ind: ${a.indent}` } : {},   // 줄(블록) 틀은 그대로, 안쪽 글자만 들여쓰기
    } } }];
  },
  addKeyboardShortcuts() {
    const ed = this.editor;
    return {
      Tab: () => tabKey(ed, 1),
      'Shift-Tab': () => tabKey(ed, -1),
      Backspace: () => {
        const { selection } = ed.state; if (!selection.empty || selection.$from.parentOffset > 0 || inListItem(ed.state)) return false;
        const b = blockAt(ed.state.doc, selection.from); if (!b || !(b.node.attrs?.indent > 0)) return false;
        return setIndent(ed, -1);
      },
      'Mod-Shift-ArrowUp': () => { const b = curBlock(ed.state); return b ? (moveBlock(ed, b, -1), true) : false; },
      'Mod-Shift-ArrowDown': () => { const b = curBlock(ed.state); return b ? (moveBlock(ed, b, 1), true) : false; },
      'Alt-Shift-ArrowUp': () => { const b = curBlock(ed.state); return b ? (moveBlock(ed, b, -1), true) : false; },
      'Alt-Shift-ArrowDown': () => { const b = curBlock(ed.state); return b ? (moveBlock(ed, b, 1), true) : false; },
      'Mod-d': () => { const b = curBlock(ed.state); if (b) duplicateBlock(ed, b); return true; },
    };
  },
  addInputRules() {
    const ed = this.editor;
    return [
      new InputRule({ find: /^>\s$/, handler: ({ range, chain }) => { chain().deleteRange(range).setDetails().run(); } }),   // Notion: "> " = 토글
    ];
  },
});
const Quote = Blockquote.extend({ addInputRules() { return [wrappingInputRule({ find: /^\s*["“]\s$/, type: this.type })]; } });  // Notion: '" ' = 인용

// 줄 왼쪽에 나타나는 ＋(아래에 추가) · ⋮⋮(잡고 끌기 / 메뉴) 손잡이
function makeHandle(editor, host) {
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const h = document.createElement('div'); h.className = 'ne-handle'; h.style.display = 'none';
  h.innerHTML = '<button type="button" class="ne-h-add" title="아래에 줄 추가 (Alt+클릭: 위에 추가)">＋</button><button type="button" class="ne-h-drag" draggable="true" title="끌어서 옮기기 · 클릭: 메뉴">⋮⋮</button>';
  host.appendChild(h);
  let cur = null, menu = null;
  const view = editor.view;
  const hide = () => { if (!menu) h.style.display = 'none'; };
  const place = blk => {
    const dom = view.nodeDOM(blk.pos); if (!dom || !dom.getBoundingClientRect) return hide();
    const r = dom.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const isLi = LIST_ITEMS.includes(blk.node.type.name);
    const lineH = Math.min(r.height, 28);
    h.style.display = 'flex';
    h.style.top = (r.top - hr.top + Math.max(0, (Math.min(lineH, 26) - 24) / 2) + (blk.node.type.name === 'heading' ? 4 : 0)) + 'px';
    h.style.left = (view.dom.getBoundingClientRect().left - hr.left - 50) + 'px';   // 모든 줄의 손잡이를 같은 세로선에 정렬
  };
  const onMove = e => {
    if (!editor.isEditable || menu || !view.dom.isConnected) return;
    if (editor._ptrDown) { if (h.style.display !== 'none') h.style.display = 'none'; return; }   // 끌어 선택 중
    const dr = view.dom.getBoundingClientRect();
    // 편집 영역 + 왼쪽 손잡이 여백까지를 "줄 위"로 본다
    const inZone = e.clientY >= dr.top - 6 && e.clientY <= dr.bottom + 6 && e.clientX >= dr.left - 90 && e.clientX <= dr.right + 30;
    if (!inZone) return hide();
    if (h.contains(e.target)) return;                         // 손잡이 위: 그대로 둔다
    if (cur && h.style.display !== 'none' && e.clientX < dr.left + 6) {
      const r = h.getBoundingClientRect();                     // 손잡이 쪽으로 가는 중이면 같은 높이에서는 줄을 바꾸지 않는다
      if (e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8) return;
    }
    const x = Math.min(Math.max(e.clientX, dr.left + 40), dr.right - 10);
    const p = view.posAtCoords({ left: x, top: e.clientY }); if (!p) return;
    let blk = null;
    if (p.inside >= 0) { const n = view.state.doc.nodeAt(p.inside); if (n && n.isAtom && n.isBlock) blk = { pos: p.inside, node: n }; }
    blk = blk || blockAt(view.state.doc, p.pos);
    if (!blk) return;
    if (cur && cur.pos === blk.pos && h.style.display !== 'none') return;
    cur = blk; place(blk);
  };
  document.addEventListener('mousemove', onMove, { passive: true });
  const fresh = () => cur && blockAt(view.state.doc, cur.pos + 1)?.pos === cur.pos ? { pos: cur.pos, node: view.state.doc.nodeAt(cur.pos) } : (cur && view.state.doc.nodeAt(cur.pos) ? { pos: cur.pos, node: view.state.doc.nodeAt(cur.pos) } : null);
  h.querySelector('.ne-h-add').addEventListener('mousedown', e => {
    e.preventDefault(); const b = fresh(); if (!b) return;
    if (e.altKey) {   // 위에 추가
      const { state } = editor; const tr = state.tr.insert(b.pos, emptyLike(state.schema, b.node));
      tr.setSelection(TextSelection.near(tr.doc.resolve(b.pos + (LIST_ITEMS.includes(b.node.type.name) ? 2 : 1)))); view.dispatch(tr); view.focus(); editor.commands.insertContent('/');
    } else addBelow(editor, b, true);
    hide();
  });
  const drag = h.querySelector('.ne-h-drag');
  drag.addEventListener('dragstart', e => {
    const b = fresh(); if (!b) return;
    const sel = NodeSelection.create(view.state.doc, b.pos);
    view.dispatch(view.state.tr.setSelection(sel));
    const slice = sel.content();
    view.dragging = { slice, move: true };
    const dom = view.nodeDOM(b.pos);
    try { e.dataTransfer.clearData(); e.dataTransfer.setData('text/html', dom?.outerHTML || ''); e.dataTransfer.setData('text/plain', dom?.textContent || ''); e.dataTransfer.effectAllowed = 'copyMove'; if (dom) e.dataTransfer.setDragImage(dom, 10, 10); } catch (x) {}
  });
  drag.addEventListener('dragend', () => { view.dragging = null; hide(); });
  drag.addEventListener('click', e => { e.preventDefault(); const b = fresh(); if (b) openMenu(b); });
  const closeMenu = () => { menu?.remove(); menu = null; document.removeEventListener('mousedown', outside, true); hide(); };
  const outside = e => { if (menu && !menu.contains(e.target) && !h.contains(e.target)) closeMenu(); };
  function openMenu(b) {
    closeMenu();
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, b.pos)));
    menu = document.createElement('div'); menu.className = 'ne-menu ne-bmenu';
    const it = (a, label, key = '') => `<button type="button" data-a="${a}" class="ne-mi"><span class="ne-ic">${label[0]}</span><span><b>${label.slice(1)}</b>${key ? `<small>${key}</small>` : ''}</span></button>`;
    const TURN = [['text', '텍스트'], ['h1', '제목 1'], ['h2', '제목 2'], ['h3', '제목 3'], ['bullet', '글머리 목록'], ['ordered', '번호 목록'], ['task', '할 일'], ['toggle', '토글'], ['quote', '인용'], ['callout', '콜아웃'], ['code', '코드']];
    menu.innerHTML = it('del', '🗑삭제', 'Del') + it('dup', '⧉복제', 'Ctrl+D') + it('split', '↵줄마다 나누기', '') + it('up', '↑위로 이동', 'Ctrl+Shift+↑') + it('down', '↓아래로 이동', 'Ctrl+Shift+↓') + it('in', '→들여쓰기', 'Tab') + it('out', '←내어쓰기', 'Shift+Tab')
      + `<div class="ne-pl" style="padding:6px 8px 2px;font-size:10px;color:#64748b">전환</div><div class="ne-turn">${TURN.map(([k, l]) => `<button type="button" data-t="${k}">${l}</button>`).join('')}</div>`
      + `<div class="ne-pl" style="padding:6px 8px 2px;font-size:10px;color:#64748b">글자색</div><div class="ne-cols">${TEXT_COLORS.map(([n, c]) => `<button type="button" data-tc="${c || ''}" title="${n}"><span style="color:${c || '#e2e8f0'}">A</span></button>`).join('')}</div>`
      + `<div class="ne-pl" style="padding:6px 8px 2px;font-size:10px;color:#64748b">배경색</div><div class="ne-cols">${BG_COLORS.map(([n, c]) => `<button type="button" data-bc="${c || ''}" title="${n}"><span style="background:${c || 'transparent'};border:1px solid #475569">A</span></button>`).join('')}</div>`;
    document.body.appendChild(menu);
    const r = h.getBoundingClientRect();
    menu.style.left = Math.min(r.right + 6, innerWidth - 270) + 'px';
    menu.style.top = Math.max(8, Math.min(r.top, innerHeight - menu.offsetHeight - 8)) + 'px';
    menu.addEventListener('mousedown', e => {
      e.preventDefault();
      const btn = e.target.closest('button'); if (!btn) return;
      const nb = view.state.doc.nodeAt(b.pos) ? { pos: b.pos, node: view.state.doc.nodeAt(b.pos) } : null; if (!nb) return closeMenu();
      const a = btn.dataset.a;
      if (a === 'del') deleteBlock(editor, nb);
      else if (a === 'dup') duplicateBlock(editor, nb);
      else if (a === 'split') { if (!splitBlockLines(editor, nb)) alert('나눌 줄이 없습니다 (한 줄짜리)'); }
      else if (a === 'up' || a === 'down') { moveBlock(editor, nb, a === 'up' ? -1 : 1); }
      else if (a === 'in' || a === 'out') { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(nb.pos + 1 + (LIST_ITEMS.includes(nb.node.type.name) ? 1 : 0))))); tabKey(editor, a === 'in' ? 1 : -1); }
      else if (btn.dataset.t) turnInto(editor, nb, btn.dataset.t);
      else if (btn.dataset.tc !== undefined) colorBlock(editor, nb, 'color', btn.dataset.tc);
      else if (btn.dataset.bc !== undefined) colorBlock(editor, nb, 'bg', btn.dataset.bc);
      closeMenu(); view.focus();
    });
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  }
  editor.on('update', () => { if (cur && h.style.display !== 'none') { const b = fresh(); if (b) place(b); else hide(); } });
  return () => { h.remove(); closeMenu(); document.removeEventListener('mousemove', onMove); };
}


// 컨센서스 자동 비교: "항목 $값, … 컨센서스($값)" 줄에서 두 값을 비교해 뒤에 상회/하회/부합을 자동으로 붙인다
function ntNum(str, fallbackScale) {
  const t = String(str || '').replace(/\s+/g, '');
  if (!t || /[~～]/.test(t)) return null;
  const m = t.match(/^(-)?\$?(-)?([\d,]*\.?\d+)([KMBT]|조|억)?(%|x|bp|배)?$/i); if (!m) return null;
  let v = parseFloat(m[3].replace(/,/g, '')); if (!isFinite(v)) return null; if (m[1] || m[2]) v = -v;
  const S = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, '조': 1e12, '억': 1e8 };
  const sc = m[4] ? (S[m[4].toUpperCase()] || S[m[4]]) : null;
  return { v, sc, pct: !!m[5] && m[5] === '%' };
}
function consVerdict(text) {
  if (text.indexOf('컨센서스') < 0) return null;
  const main = text.match(/^(.+?)\s+(-?\$?\s?-?[\d,]*\.?\d+\s*(?:[KMBT](?![a-z])|조|억)?\s*(?:%|x|bp|배)?)(?=\s*(?:,|\(|$))/i);
  const cm = /컨센서스\s*\(\s*([^)]*?)\s*\)/.exec(text);
  if (!main || !cm || !/\d/.test(cm[1])) return null;
  const a = ntNum(main[2]), b = ntNum(cm[1]);
  if (!a || !b) return null;
  const sa = a.sc || 1, sb = b.sc || a.sc || 1;
  const va = a.v * sa, vb = b.v * sb;
  const eps = Math.max(Math.abs(va), Math.abs(vb)) * 1e-9;
  const verdict = Math.abs(va - vb) <= eps ? '부합' : va > vb ? '상회' : '하회';
  // 차이: 금액·배수는 컨센서스 대비 %, 비율(%) 항목은 bp 차이
  let diff = '';
  if (verdict !== '부합') {
    if (a.pct && b.pct) { const bp = Math.round((a.v - b.v) * 100); diff = (bp > 0 ? '+' : '') + bp + 'bp'; }
    else if (vb !== 0) { const pc = (va - vb) / Math.abs(vb) * 100; diff = (pc > 0 ? '+' : '') + pc.toFixed(1) + '%'; }
  }
  const label = diff ? `${diff} ${verdict}` : verdict;
  const close = cm.index + cm[0].length;               // ')' 다음 위치
  const rest = text.slice(close);
  const ex = rest.match(/^(\s*)((?:[+-]?\d[\d,]*(?:\.\d+)?\s*(?:%|bp)\s*)?(상회|하회|부합))/);
  return { verdict, label, close, existing: ex ? { from: close + ex[1].length, to: close + ex[0].length, word: ex[2] } : null };
}

// 컨센서스 줄 고치기(공용): 붙일 위치를 뒤쪽 줄부터 고쳐서 위치가 어긋나지 않게
const normColor = c => { c = String(c || '').toLowerCase().replace(/\s+/g, ''); const m = c.match(/^#([0-9a-f]{6})$/); return m ? `rgb(${parseInt(m[1].slice(0, 2), 16)},${parseInt(m[1].slice(2, 4), 16)},${parseInt(m[1].slice(4, 6), 16)})` : c; };
function fixConsensusBlocks(state, tr, entries) {
  let changed = false;
  entries.sort((a, b) => b[0] - a[0]).forEach(([pos, blk]) => {
    if (blk.textContent.indexOf('컨센서스') < 0) return;
    const start = pos + 1; let text = ''; const map = [];
    blk.forEach((ch, off) => { if (ch.isText) { for (let i = 0; i < ch.text.length; i++) { text += ch.text[i]; map.push(start + off + i); } } else { text += '\n'; map.push(start + off); } });
    const r = consVerdict(text); if (!r) return;
    const color = r.verdict === '상회' ? '#a3e635' : r.verdict === '하회' ? '#f87171' : '#ffffff';   // 연두 / 빨강 / 흰색
    if (r.existing && r.existing.word === r.label) {
      // 글자는 맞지만 색이 다르면(예전 버전·직접 입력) 색만 맞춘다
      const a = map[r.existing.from], b = map[r.existing.to - 1] + 1;
      let ok = true; state.doc.nodesBetween(a, b, n => { if (n.isText && !n.marks.some(m => m.type.name === 'textStyle' && normColor(m.attrs.color) === normColor(color))) ok = false; });
      if (ok) return;
      const ts = state.schema.marks.textStyle; if (ts) { tr.removeMark(a, b, ts); tr.addMark(a, b, ts.create({ color })); changed = true; }
      return;
    }
    let from;
    if (r.existing) { from = map[r.existing.from]; tr.insertText(r.label, from, map[r.existing.to - 1] + 1); }
    else { const at = map[r.close - 1] + 1; tr.insertText(' ', at); from = at + 1; tr.insertText(r.label, from); }
    const ts = state.schema.marks.textStyle;
    if (ts) { tr.removeMark(from, from + r.label.length, ts); tr.addMark(from, from + r.label.length, ts.create({ color })); }
    changed = true;
  });
  return changed;
}
function normalizeConsensus(editor) {
  const { state } = editor; const entries = [];
  state.doc.descendants((n, pos) => { if (n.isTextblock) { if (n.textContent.indexOf('컨센서스') >= 0) entries.push([pos, n]); return false; } return true; });
  if (!entries.length) return false;
  const tr = state.tr;
  if (!fixConsensusBlocks(state, tr, entries)) return false;
  tr.setMeta('consensusAuto', true); tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
  return true;
}

const ConsensusAuto = Extension.create({
  name: 'consensusAuto',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('consensusAuto'),
      appendTransaction(trs, oldState, state) {
        if (!trs.some(t => t.docChanged) || trs.some(t => t.getMeta('consensusAuto'))) return null;
        // 이번 변경이 닿은 줄들(붙여넣기로 여러 줄이 바뀐 경우 포함)을 모두 확인
        const ranges = [];
        trs.forEach((t, ti) => t.steps.forEach((st, si) => st.getMap().forEach((a, b, from, to) => {
          let f = from, e = to;
          for (let k = si + 1; k < t.steps.length; k++) { f = t.steps[k].getMap().map(f, -1); e = t.steps[k].getMap().map(e, 1); }
          for (let j = ti + 1; j < trs.length; j++) { f = trs[j].mapping.map(f, -1); e = trs[j].mapping.map(e, 1); }
          ranges.push([Math.max(0, f), Math.min(state.doc.content.size, e)]);
        })));
        const blocks = new Map();
        ranges.forEach(([f, e]) => state.doc.nodesBetween(f, Math.max(f, e), (n, pos) => { if (n.isTextblock) { blocks.set(pos, n); return false; } return blocks.size < 300; }));
        const tr = state.tr;
        const changed = fixConsensusBlocks(state, tr, [...blocks.entries()]);
        if (!changed) return null;
        tr.setMeta('consensusAuto', true);
        return tr;
      },
    })];
  },
});
// 바깥(웹·문서)에서 붙여넣은 글의 글자색·배경색·글꼴은 지워서 기본(흰색) 글씨로
function cleanPastedHTML(html) {
  if (/data-pm-slice/.test(html)) return html;            // 이 편집기 안에서 복사한 것은 서식 유지
  return html
    .replace(/(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (m, a, q, st) => {
      const keep = st.split(';').filter(d => d.trim() && !/^\s*(color|background|background-color|font-family|font-size|line-height|caret-color|-webkit-text-fill-color)\s*:/i.test(d)).join(';');
      return keep ? `${a}${q}${keep}${q}` : '';
    })
    .replace(/(<font\b[^>]*?)\s(color|face|size)\s*=\s*(["'][^"']*["']|\S+)/gi, '$1')
    .replace(/\s(bgcolor|color)\s*=\s*(["'][^"']*["'])/gi, '');
}


// 여러 줄을 붙여넣으면 줄마다 Enter를 친 것처럼 나눈다 (목록 안이면 줄마다 새 글머리, 아니면 줄마다 새 문단)
function pasteLines(editor, slice) {
  const { state } = editor;
  const top = []; slice.content.forEach(n => top.push(n));
  if (!top.length || !top.every(n => n.isTextblock)) return false;   // 목록·표 등 구조가 있는 붙여넣기는 기본 동작
  const segs = [];
  top.forEach(n => {
    let cur = [];
    n.forEach(ch => { if (ch.type.name === 'hardBreak') { segs.push(cur); cur = []; } else cur.push(ch); });
    segs.push(cur);
  });
  const lines = segs.filter(seg => seg.some(ch => !ch.isText || ch.text.trim()));
  if (lines.length < 2) return false;
  const li = inListItem(state);
  const bullet = /^\s*(?:[•·▪◦‣∙●○■□\-–—*]|\d{1,2}[.)])\s+/;
  lines.forEach((seg, i) => {
    if (i > 0) { if (li) editor.commands.splitListItem(inListItem(editor.state) || li); else editor.commands.splitBlock(); }
    let nodes = seg.slice();
    if (li && nodes[0] && nodes[0].isText) {   // 목록 안에서는 줄 앞의 "•", "-", "1." 같은 기호를 뗀다
      const t = nodes[0].text.replace(bullet, '').replace(/^\s+/, '');
      nodes[0] = t ? nodes[0].withText(t) : null; nodes = nodes.filter(Boolean);
    } else if (nodes[0] && nodes[0].isText) { const t = nodes[0].text.replace(/^\s+/, ''); nodes[0] = t ? nodes[0].withText(t) : null; nodes = nodes.filter(Boolean); }
    if (!nodes.length) return;
    const { tr } = editor.state;
    tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0));
    editor.view.dispatch(tr.scrollIntoView());
  });
  return true;
}


// 이미 한 줄(한 글머리)에 뭉쳐 있는 내용을 줄마다 나누기 (줄 메뉴 ⋮⋮ → 줄마다 나누기)
function splitBlockLines(editor, blk) {
  const { state, view } = editor; const sch = state.schema; const node = blk.node;
  const segsOf = tb => { const out = []; let cur = []; tb.forEach(ch => { if (ch.type.name === 'hardBreak') { out.push(cur); cur = []; } else cur.push(ch); }); out.push(cur); return out.filter(sg => sg.some(c => !c.isText || c.text.trim())); };
  let nodes = [];
  if (LIST_ITEMS.includes(node.type.name)) {
    const paras = [], rest = [];
    node.forEach(ch => (ch.isTextblock ? paras : rest).push(ch));
    paras.forEach(tb => segsOf(tb).forEach(sg => nodes.push(node.type.create(node.type.name === 'taskItem' ? { checked: false } : null, sch.nodes.paragraph.create(null, sg)))));
    if (!nodes.length) return false;
    if (rest.length) { const last = nodes[nodes.length - 1]; nodes[nodes.length - 1] = last.type.create(last.attrs, last.content.append(Fragment.fromArray(rest))); }
  } else if (node.isTextblock) {
    nodes = segsOf(node).map(sg => node.type.create(node.attrs, sg));
  }
  if (nodes.length < 2) return false;
  view.dispatch(state.tr.replaceWith(blk.pos, blk.pos + node.nodeSize, Fragment.fromArray(nodes)));
  return true;
}

export function create(el, opts = {}) {
  const upload = opts.upload || null;
  const editor = new Editor({
    element: el,
    editable: !!opts.editable,
    content: opts.html || '',
    extensions: [
      StarterKit.configure({ blockquote: false, heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: !opts.editable, autolink: true, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } } }),
      TextStyle, Color, BackgroundColor,
      TaskList, TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      Details.configure({ persist: true, HTMLAttributes: { class: 'ne-details' } }), DetailsSummary, DetailsContent,
      Image.configure({ inline: false, allowBase64: false }),
      Callout, Quote, Indent, ConsensusAuto,
      Placeholder.configure({ placeholder: ({ node }) => node.type.name === 'heading' ? '제목' : (node.type.name === 'detailsSummary' ? '토글 제목' : "내용을 입력하거나 '/'로 블록 추가"), includeChildren: false }),
      makeSlash(() => upload), Keys,
    ],
    editorProps: {
      attributes: { class: 'ne-doc' },
      transformPastedHTML: cleanPastedHTML,
      handlePaste: (view, e, slice) => { const fs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/')); if (fs.length && upload && opts.editable) { uploadAndInsert(editor, upload, fs); return true; } if (opts.editable && opts.splitPaste !== false && !editor.isActive('codeBlock') && !editor.isActive('table') && slice && pasteLines(editor, slice)) return true; return false; },
      handleDrop: (view, e) => { const fs = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/')); if (fs.length && upload && opts.editable) { const p = view.posAtCoords({ left: e.clientX, top: e.clientY }); uploadAndInsert(editor, upload, fs, p?.pos); return true; } return false; },
    },
    onUpdate: ({ editor }) => opts.onUpdate && opts.onUpdate(editor),
  });
  if (opts.onSave) editor.on('save-now', () => opts.onSave(editor));
  // 편집 모드로 열 때: 예전에 적힌 상회/하회도 지금 규칙(차이 %·색상)으로 한 번에 맞춘다
  if (opts.editable) setTimeout(() => { try { normalizeConsensus(editor); } catch (e) {} }, 0);
  // 마우스로 끌어 선택하는 동안에는 손잡이·서식 툴바를 움직이지 않는다(화면이 위아래로 튀지 않게)
  editor._ptrDown = false;
  const onDown = e => { if (e.button === 0) editor._ptrDown = true; };
  const onUp = () => { if (editor._ptrDown) { editor._ptrDown = false; editor.emit('pointer-up'); } };
  editor.view.dom.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp, true);
  const cleanups = [makeBubble(editor), makeTableBar(editor), () => { editor.view.dom.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp, true); }];
  if (opts.editable) cleanups.push(makeHandle(editor, el));
  editor.blockOps = { blockAt: p => blockAt(editor.state.doc, p), addBelow: (b, s) => addBelow(editor, b, s), deleteBlock: b => deleteBlock(editor, b), duplicateBlock: b => duplicateBlock(editor, b), moveBlock: (b, d) => moveBlock(editor, b, d), tab: d => tabKey(editor, d), turnInto: (b, k) => turnInto(editor, b, k), split: b => splitBlockLines(editor, b) };
  const origDestroy = editor.destroy.bind(editor);
  editor.destroy = () => { cleanups.forEach(f => f()); origDestroy(); };
  return editor;
}
export const COLORS = { TEXT_COLORS, BG_COLORS };
