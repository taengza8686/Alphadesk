// AlphaDesk 노트 편집기 (Notion 스타일) — TipTap 기반, 빌드 결과: site/vendor/note-editor.js
import { Editor, Extension, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color, BackgroundColor } from '@tiptap/extension-text-style';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Details, DetailsSummary, DetailsContent } from '@tiptap/extension-details';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';

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
    if (empty || !editor.isEditable || !editor.isFocused || editor.isActive('image')) { el.style.display = 'none'; pal.style.display = 'none'; return; }
    const a = editor.view.coordsAtPos(from), b = editor.view.coordsAtPos(to);
    el.style.display = 'block';
    const w = el.offsetWidth;
    el.style.left = Math.max(8, Math.min((a.left + b.left) / 2 - w / 2, innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, a.top - el.offsetHeight - 8) + 'px';
    ['bold', 'italic', 'underline', 'strike', 'code', 'link'].forEach(k => el.querySelector(`[data-a="${k}"]`).classList.toggle('on', editor.isActive(k)));
  };
  editor.on('selectionUpdate', upd); editor.on('blur', () => setTimeout(upd, 150)); editor.on('focus', upd);
  addEventListener('scroll', upd, true);
  return () => { el.remove(); removeEventListener('scroll', upd, true); };
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
    if (!editor.isEditable || !editor.isActive('table') || !editor.isFocused) { el.style.display = 'none'; return; }
    let dom = editor.view.domAtPos(editor.state.selection.from).node; while (dom && dom.nodeName !== 'TABLE') dom = dom.parentNode;
    if (!dom) { el.style.display = 'none'; return; }
    const r = dom.getBoundingClientRect(); el.style.display = 'block';
    el.style.left = Math.max(8, r.left) + 'px'; el.style.top = Math.max(8, r.top - el.offsetHeight - 6) + 'px';
  };
  editor.on('selectionUpdate', upd); editor.on('blur', () => setTimeout(upd, 150)); editor.on('focus', upd); addEventListener('scroll', upd, true);
  return () => { el.remove(); removeEventListener('scroll', upd, true); };
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

export function create(el, opts = {}) {
  const upload = opts.upload || null;
  const editor = new Editor({
    element: el,
    editable: !!opts.editable,
    content: opts.html || '',
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: !opts.editable, autolink: true, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } } }),
      TextStyle, Color, BackgroundColor,
      TaskList, TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      Details.configure({ persist: true, HTMLAttributes: { class: 'ne-details' } }), DetailsSummary, DetailsContent,
      Image.configure({ inline: false, allowBase64: false }),
      Callout,
      Placeholder.configure({ placeholder: ({ node }) => node.type.name === 'heading' ? '제목' : (node.type.name === 'detailsSummary' ? '토글 제목' : "내용을 입력하거나 '/'로 블록 추가"), includeChildren: false }),
      makeSlash(() => upload), Keys,
    ],
    editorProps: {
      attributes: { class: 'ne-doc' },
      handlePaste: (view, e) => { const fs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/')); if (fs.length && upload && opts.editable) { uploadAndInsert(editor, upload, fs); return true; } return false; },
      handleDrop: (view, e) => { const fs = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/')); if (fs.length && upload && opts.editable) { const p = view.posAtCoords({ left: e.clientX, top: e.clientY }); uploadAndInsert(editor, upload, fs, p?.pos); return true; } return false; },
    },
    onUpdate: ({ editor }) => opts.onUpdate && opts.onUpdate(editor),
  });
  if (opts.onSave) editor.on('save-now', () => opts.onSave(editor));
  const cleanups = [makeBubble(editor), makeTableBar(editor)];
  const origDestroy = editor.destroy.bind(editor);
  editor.destroy = () => { cleanups.forEach(f => f()); origDestroy(); };
  return editor;
}
export const COLORS = { TEXT_COLORS, BG_COLORS };
