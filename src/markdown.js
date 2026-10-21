/**
 * markdown.js —— 极简 Markdown 渲染（服务端，零依赖）
 *
 * 只支持复习文档用到的语法：标题、加粗、列表、表格、代码块、
 * 引用、水平线、行内代码。不做通用实现，避免引入依赖和 XSS 面。
 *
 * 安全：所有文本先做 HTML 转义，再拼标签。
 */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 行内：`code` **bold** *italic* [text](url) */
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return t;
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inList = false;
  let listTag = 'ul';

  const closeList = () => {
    if (inList) { out.push('</' + listTag + '>'); inList = false; }
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');

    // 代码块
    if (/^```/.test(line.trim())) {
      closeList();
      const lang = line.trim().slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre class="md-code"><code data-lang="' + esc(lang) + '">' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // 空行
    if (!line.trim()) { closeList(); i++; continue; }

    // 水平线
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr>'); i++; continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push('<h' + lvl + ' class="md-h md-h' + lvl + '">' + inline(h[2]) + '</h' + lvl + '>');
      i++;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push('<blockquote class="md-quote">' + buf.map((b) => inline(b)).join('<br>') + '</blockquote>');
      continue;
    }

    // 表格
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      closeList();
      const head = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>'
        + head.map((c) => '<th>' + inline(c) + '</th>').join('')
        + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    // 列表（有序 / 无序，支持一层缩进）
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const tag = ordered ? 'ol' : 'ul';
      if (!inList || listTag !== tag) {
        closeList();
        out.push('<' + tag + ' class="md-list">');
        inList = true;
        listTag = tag;
      }
      out.push('<li>' + inline(li[3]) + '</li>');
      i++;
      continue;
    }

    // 普通段落
    closeList();
    out.push('<p class="md-p">' + inline(line) + '</p>');
    i++;
  }

  closeList();
  return out.join('\n');
}
