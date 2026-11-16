(function () {
  'use strict';

  var AJAX = '/api/admin-ajax';
  var KEY_INDEX = 'se-test-drafts';
  var KEY_DRAFT = 'se-test-draft-';
  var CATEGORIES = [
    { name: 'NFL', covered: true },
    { name: 'NBA', covered: true },
    { name: 'MLB', covered: false },
    { name: 'NHL', covered: false },
    { name: 'College Football', covered: false },
    { name: 'Tennis', covered: false }
  ];
  var TEXT_TYPES = { 'core/paragraph': 1, 'core/heading': 1, 'core/list': 1, 'core/quote': 1 };
  var INLINE = { STRONG: 1, B: 1, EM: 1, I: 1, SUP: 1, SUB: 1, CODE: 1, U: 1 };
  var TYPE_LABELS = {
    'core/paragraph': 'Paragraph', 'core/heading': 'Heading', 'core/list': 'List',
    'core/quote': 'Quote', 'core/image': 'Image', 'core/table': 'Table', 'core/html': 'HTML'
  };

  var doc = null;
  var selected = null;
  var history = [];
  var future = [];
  var typing = false;
  var typingTimer = null;
  var saveTimer = null;
  var panelLoaded = false;
  var seq = 0;

  function $(s, el) { return (el || document).querySelector(s); }
  function $all(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }

  var store = {
    get: function (k) { try { return JSON.parse(window.localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    remove: function (k) { try { window.localStorage.removeItem(k); } catch (e) { return; } }
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function newId() { return 'b' + Date.now().toString(36) + (++seq).toString(36); }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function textOf(html) {
    var t = document.createElement('template');
    t.innerHTML = html || '';
    return (t.content.textContent || '').replace(/ /g, ' ').trim();
  }

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function cleanNode(node) {
    var out = '';
    Array.prototype.forEach.call(node.childNodes, function (n) {
      if (n.nodeType === 3) {
        out += esc(n.nodeValue.replace(/\s+/g, ' '));
      } else if (n.nodeType === 1) {
        var tag = n.tagName;
        if (tag === 'BR') {
          out += '<br>';
          return;
        }
        if (tag === 'SCRIPT' || tag === 'STYLE') {
          return;
        }
        var inner = cleanNode(n);
        if (tag === 'A') {
          var href = n.getAttribute('href') || '';
          out += /^https?:\/\//i.test(href) ? '<a href="' + escAttr(href) + '">' + inner + '</a>' : inner;
        } else if (INLINE[tag]) {
          var t = tag === 'B' ? 'strong' : tag === 'I' ? 'em' : tag.toLowerCase();
          out += inner ? '<' + t + '>' + inner + '</' + t + '>' : '';
        } else if (tag === 'SPAN' && inner.trim()) {
          var st = n.style || {};
          var bold = /^(bold|bolder|[6-9]00)$/.test(String(st.fontWeight || ''));
          var ital = st.fontStyle === 'italic';
          out += (bold ? '<strong>' : '') + (ital ? '<em>' : '') + inner + (ital ? '</em>' : '') + (bold ? '</strong>' : '');
        } else {
          out += inner;
        }
      }
    });
    return out;
  }

  function cleanInline(html) {
    var t = document.createElement('template');
    t.innerHTML = html || '';
    return cleanNode(t.content).replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
  }

  function mk(name, attrs) { return { clientId: newId(), name: name, attributes: attrs || {} }; }
  function para(html) { return mk('core/paragraph', { content: html || '' }); }

  function imageBlock(img, cap) {
    var src = img.getAttribute('src') || '';
    if (!/^https?:\/\//i.test(src)) {
      return null;
    }
    return mk('core/image', { url: src, alt: img.getAttribute('alt') || '', caption: cap ? cleanInline(cap.innerHTML) : '' });
  }

  function cellsOf(tr) {
    return { cells: Array.prototype.map.call(tr.children, function (c) { return { content: cleanInline(c.innerHTML), tag: c.tagName === 'TH' ? 'th' : 'td' }; }) };
  }

  function tableFromEl(table, cap) {
    var rows = Array.prototype.slice.call(table.querySelectorAll('tr'));
    var head = [];
    var body = [];
    var theadRows = Array.prototype.slice.call(table.querySelectorAll('thead tr'));
    if (theadRows.length) {
      head = theadRows.map(cellsOf);
      body = rows.filter(function (r) { return theadRows.indexOf(r) < 0; }).map(cellsOf);
    } else if (rows.length && rows[0].querySelector('th') && !rows[0].querySelector('td')) {
      head = [cellsOf(rows[0])];
      body = rows.slice(1).map(cellsOf);
    } else {
      body = rows.map(cellsOf);
    }
    return mk('core/table', { head: head, body: body, caption: cap ? cleanInline(cap.innerHTML) : '' });
  }

  function hasBlockChild(n) { return !!n.querySelector('p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,figure,table,img,div'); }

  function htmlToBlocks(html) {
    var t = document.createElement('template');
    t.innerHTML = html || '';
    var out = [];
    var buf = '';
    function flush() {
      var c = cleanInline(buf);
      if (textOf(c)) {
        out.push(para(c));
      }
      buf = '';
    }
    function walk(parent) {
      Array.prototype.forEach.call(parent.childNodes, function (n) {
        if (n.nodeType === 3) {
          buf += esc(n.nodeValue);
          return;
        }
        if (n.nodeType !== 1) {
          return;
        }
        var tag = n.tagName;
        if (['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'IFRAME', 'SVG', 'BUTTON', 'FORM'].indexOf(tag) >= 0) {
          return;
        }
        if (tag === 'P') {
          flush();
          if (n.querySelector('img') && !textOf(n.innerHTML)) {
            var pi = imageBlock(n.querySelector('img'), null);
            if (pi) { out.push(pi); }
            return;
          }
          var c = cleanInline(n.innerHTML);
          if (textOf(c)) { out.push(para(c)); }
        } else if (/^H[1-6]$/.test(tag)) {
          flush();
          var hc = cleanInline(n.innerHTML);
          if (textOf(hc)) { out.push(mk('core/heading', { content: hc, level: Math.min(4, Math.max(2, +tag.charAt(1))) })); }
        } else if (tag === 'UL' || tag === 'OL') {
          flush();
          var items = Array.prototype.filter.call(n.children, function (li) { return li.tagName === 'LI'; })
            .map(function (li) { return cleanInline(li.innerHTML); })
            .filter(function (x) { return textOf(x); })
            .map(function (x) { return '<li>' + x + '</li>'; }).join('');
          if (items) { out.push(mk('core/list', { ordered: tag === 'OL', values: items })); }
        } else if (tag === 'BLOCKQUOTE') {
          flush();
          var q = cleanInline(n.innerHTML.replace(/<\/p>\s*<p[^>]*>/gi, '<br>'));
          if (textOf(q)) { out.push(mk('core/quote', { value: q })); }
        } else if (tag === 'FIGURE') {
          flush();
          var cap = n.querySelector('figcaption');
          if (n.querySelector('table')) {
            out.push(tableFromEl(n.querySelector('table'), cap));
          } else if (n.querySelector('img')) {
            var fi = imageBlock(n.querySelector('img'), cap);
            if (fi) { out.push(fi); }
          }
        } else if (tag === 'IMG') {
          flush();
          var ib = imageBlock(n, null);
          if (ib) { out.push(ib); }
        } else if (tag === 'TABLE') {
          flush();
          out.push(tableFromEl(n, null));
        } else if (tag === 'BR') {
          buf += '<br>';
        } else if (hasBlockChild(n)) {
          flush();
          walk(n);
          flush();
        } else if (['DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'LI'].indexOf(tag) >= 0) {
          flush();
          var dc = cleanInline(n.innerHTML);
          if (textOf(dc)) { out.push(para(dc)); }
        } else {
          buf += n.outerHTML;
        }
      });
    }
    walk(t.content);
    flush();
    return out;
  }

  function plainToBlocks(text) {
    return String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(Boolean).map(function (l) { return para(esc(l)); });
  }

  function rowsHtml(tag, rows) {
    if (!rows || !rows.length) {
      return '';
    }
    return '<' + tag + '>' + rows.map(function (r) {
      return '<tr>' + (r.cells || []).map(function (c) {
        var t = c.tag || (tag === 'thead' ? 'th' : 'td');
        return '<' + t + '>' + (c.content || '') + '</' + t + '>';
      }).join('') + '</tr>';
    }).join('') + '</' + tag + '>';
  }

  function serialize(b) {
    var a = b.attributes || {};
    switch (b.name) {
      case 'core/paragraph':
        return '<p>' + (a.content || '') + '</p>';
      case 'core/heading':
        var l = a.level || 2;
        return '<h' + l + '>' + (a.content || '') + '</h' + l + '>';
      case 'core/list':
        var lt = a.ordered ? 'ol' : 'ul';
        return '<' + lt + '>' + (a.values || '') + '</' + lt + '>';
      case 'core/quote':
        return '<blockquote><p>' + (a.value || '') + '</p></blockquote>';
      case 'core/image':
        return a.url ? '<figure class="wp-block-image"><img src="' + escAttr(a.url) + '" alt="' + escAttr(a.alt || '') + '"/>'
          + (a.caption ? '<figcaption>' + a.caption + '</figcaption>' : '') + '</figure>' : '';
      case 'core/table':
        return '<figure class="wp-block-table"><table>' + rowsHtml('thead', a.head) + rowsHtml('tbody', a.body) + '</table>'
          + (a.caption ? '<figcaption>' + a.caption + '</figcaption>' : '') + '</figure>';
      default:
        return a.content || '';
    }
  }

  function postContent() {
    return doc.blocks.map(serialize).filter(Boolean).join('\n\n');
  }

  function normalizeAttrs(name, attrs) {
    if (name === 'core/image') {
      return { url: attrs.url || '', alt: attrs.alt || '', caption: attrs.caption || '', id: attrs.id || null };
    }
    if (name === 'core/table') {
      return { head: attrs.head || [], body: attrs.body || [], caption: attrs.caption || '' };
    }
    return JSON.parse(JSON.stringify(attrs || {}));
  }

  function indexOf(id) {
    for (var i = 0; i < doc.blocks.length; i++) {
      if (doc.blocks[i].clientId === id) {
        return i;
      }
    }
    return -1;
  }

  function blockEl(id) { return document.querySelector('.blk[data-block="' + id + '"]'); }

  function snapshot() { return JSON.stringify({ title: doc.title, blocks: doc.blocks }); }

  function pushHistory() {
    var s = snapshot();
    if (history[history.length - 1] !== s) {
      history.push(s);
      if (history.length > 100) {
        history.shift();
      }
    }
    future = [];
    updateUndo();
  }

  function restore(s) {
    var o = JSON.parse(s);
    doc.title = o.title;
    doc.blocks = o.blocks;
    $('#post-title').value = doc.title;
    sizeTitle();
    renderBlocks();
    scheduleSave();
    updateUndo();
  }

  function undo() {
    if (!history.length) {
      return;
    }
    future.push(snapshot());
    restore(history.pop());
  }

  function redo() {
    if (!future.length) {
      return;
    }
    history.push(snapshot());
    restore(future.pop());
  }

  function updateUndo() {
    $('#tb-undo').disabled = !history.length;
    $('#tb-redo').disabled = !future.length;
  }

  function beforeTyping() {
    if (!typing) {
      pushHistory();
      typing = true;
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () { typing = false; }, 1200);
  }

  function draftIndex() { return store.get(KEY_INDEX) || []; }

  function saveDraft() {
    clearTimeout(saveTimer);
    doc.updated = Date.now();
    var ok = store.set(KEY_DRAFT + doc.id, doc);
    var idx = draftIndex().filter(function (d) { return d.id !== doc.id; });
    idx.unshift({ id: doc.id, title: doc.title || 'Untitled draft', updated: doc.updated });
    store.set(KEY_INDEX, idx.slice(0, 50));
    $('#tb-saved').textContent = ok ? 'Saved' : 'Not saved: browser storage is full or blocked';
    $('#tb-doc').textContent = doc.title || 'Untitled draft';
  }

  function scheduleSave() {
    $('#tb-saved').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 700);
  }

  function newDraft() {
    return { id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: '', blocks: [], categories: [],
      catOther: '', tags: '', date: today(), jobId: '', used: [], updated: Date.now() };
  }

  function loadDraft(id) {
    var d = id ? store.get(KEY_DRAFT + id) : null;
    if (!d || !Array.isArray(d.blocks)) {
      return null;
    }
    d.categories = d.categories || [];
    d.used = d.used || [];
    return d;
  }

  function openDraft(id) {
    var u = new URL(window.location.href);
    u.searchParams.set('draft', id);
    window.location.href = u.toString();
  }

  function categoryList() {
    var out = doc.categories.slice();
    String(doc.catOther || '').split(',').forEach(function (c) {
      c = c.trim();
      if (c && out.indexOf(c) < 0) {
        out.push(c);
      }
    });
    return out;
  }

  function tagList() {
    return String(doc.tags || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function sizeTitle() {
    var t = $('#post-title');
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 'px';
  }

  var toolbar = null;

  function buildToolbar() {
    var bar = document.createElement('div');
    bar.className = 'blk-toolbar';
    bar.innerHTML = '<select aria-label="Block type">'
      + '<option value="core/paragraph">Paragraph</option>'
      + '<option value="h2">Heading 2</option>'
      + '<option value="h3">Heading 3</option>'
      + '<option value="h4">Heading 4</option>'
      + '<option value="core/list">List</option>'
      + '<option value="core/quote">Quote</option>'
      + '<option value="core/image" disabled>Image</option>'
      + '<option value="core/table" disabled>Table</option>'
      + '</select>'
      + '<button type="button" data-act="up" title="Move up" aria-label="Move up">↑</button>'
      + '<button type="button" data-act="down" title="Move down" aria-label="Move down">↓</button>'
      + '<button type="button" data-act="remove" title="Remove block" aria-label="Remove block">🗑</button>';
    bar.addEventListener('mousedown', function (e) {
      if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'OPTION') {
        e.preventDefault();
      }
    });
    bar.querySelector('select').addEventListener('change', function (e) { transform(selected, e.target.value); });
    bar.addEventListener('click', function (e) {
      var act = e.target.getAttribute('data-act');
      if (act === 'up') { move(selected, -1); }
      if (act === 'down') { move(selected, 1); }
      if (act === 'remove') { removeBlock(selected); }
    });
    return bar;
  }

  function syncToolbar() {
    var b = doc.blocks[indexOf(selected)];
    if (!b || !toolbar) {
      return;
    }
    var sel = toolbar.querySelector('select');
    sel.value = b.name === 'core/heading' ? 'h' + (b.attributes.level || 2) : b.name;
    sel.disabled = !TEXT_TYPES[b.name];
  }

  function select(id) {
    if (!toolbar) {
      toolbar = buildToolbar();
    }
    $all('.blk.is-selected').forEach(function (el) { el.classList.remove('is-selected'); });
    selected = id;
    var w = id ? blockEl(id) : null;
    if (w) {
      w.classList.add('is-selected');
      if (toolbar.parentNode !== w) {
        w.insertBefore(toolbar, w.firstChild);
      }
      syncToolbar();
    } else if (toolbar.parentNode) {
      toolbar.parentNode.removeChild(toolbar);
    }
  }

  function placeCaret(el, atEnd) {
    el.focus();
    var r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(!atEnd);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  function focusBlock(id, atEnd) {
    var w = blockEl(id);
    if (!w) {
      return;
    }
    select(id);
    var el = w.querySelector('.blk-content[contenteditable="true"]') || w.querySelector('figcaption[contenteditable="true"]');
    if (el) {
      placeCaret(el, atEnd);
    } else {
      w.scrollIntoView({ block: 'nearest' });
    }
  }

  function caretAt(el, end) {
    var s = window.getSelection();
    if (!s.rangeCount || !s.isCollapsed) {
      return false;
    }
    var r = s.getRangeAt(0);
    var probe = document.createRange();
    probe.selectNodeContents(el);
    try {
      if (end) {
        probe.setStart(r.endContainer, r.endOffset);
      } else {
        probe.setEnd(r.startContainer, r.startOffset);
      }
    } catch (e) {
      return false;
    }
    return probe.toString().replace(/[​\s]/g, '') === '';
  }

  function contentKey(b) { return b.name === 'core/list' ? 'values' : b.name === 'core/quote' ? 'value' : 'content'; }

  function readEditable(b, el) {
    if (b.name === 'core/list') {
      var lis = Array.prototype.filter.call(el.children, function (c) { return c.tagName === 'LI'; });
      b.attributes.values = lis.length
        ? lis.map(function (li) { return '<li>' + cleanInline(li.innerHTML) + '</li>'; }).join('')
        : (textOf(el.innerHTML) ? '<li>' + cleanInline(el.innerHTML) + '</li>' : '');
    } else {
      b.attributes[contentKey(b)] = cleanInline(el.innerHTML);
    }
  }

  function textHtml(b) {
    var a = b.attributes;
    if (b.name === 'core/list') {
      return a.values || '<li></li>';
    }
    return b.name === 'core/quote' ? (a.value || '') : (a.content || '');
  }

  function renderText(b, wrap) {
    var tag = b.name === 'core/heading' ? 'h' + (b.attributes.level || 2)
      : b.name === 'core/list' ? (b.attributes.ordered ? 'ol' : 'ul')
      : b.name === 'core/quote' ? 'blockquote' : 'p';
    var el = document.createElement(tag);
    el.className = 'blk-content';
    el.contentEditable = 'true';
    el.setAttribute('data-placeholder', b.name === 'core/heading' ? 'Heading' : b.name === 'core/quote' ? 'Add quote' : 'Type / to choose a block');
    el.innerHTML = textHtml(b);
    el.addEventListener('beforeinput', beforeTyping);
    el.addEventListener('input', function () { readEditable(b, el); scheduleSave(); });
    el.addEventListener('focus', function () { if (selected !== b.clientId) { select(b.clientId); } });
    el.addEventListener('keydown', function (e) { onKey(e, b, el); });
    el.addEventListener('paste', function (e) { onPaste(e, b, el); });
    wrap.appendChild(el);
  }

  function editableCaption(wrap, b, fig) {
    var cap = document.createElement('figcaption');
    cap.contentEditable = 'true';
    cap.innerHTML = b.attributes.caption || '';
    cap.addEventListener('beforeinput', beforeTyping);
    cap.addEventListener('input', function () { b.attributes.caption = cleanInline(cap.innerHTML); scheduleSave(); });
    cap.addEventListener('focus', function () { if (selected !== b.clientId) { select(b.clientId); } });
    cap.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        insertAfter(b.clientId, [para('')], true);
      }
    });
    fig.appendChild(cap);
  }

  function renderImage(b, wrap) {
    var fig = document.createElement('figure');
    if (b.attributes.url) {
      var img = document.createElement('img');
      img.src = b.attributes.url;
      img.alt = b.attributes.alt || '';
      img.loading = 'lazy';
      fig.appendChild(img);
    } else {
      var empty = document.createElement('div');
      empty.className = 'img-empty';
      empty.innerHTML = '<strong>Image</strong><br>Paste an image link and press Enter';
      var input = document.createElement('input');
      input.type = 'url';
      input.placeholder = 'https://…';
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && /^https?:\/\//i.test(input.value.trim())) {
          e.preventDefault();
          pushHistory();
          b.attributes.url = input.value.trim();
          renderBlocks();
          scheduleSave();
        }
      });
      empty.appendChild(input);
      fig.appendChild(empty);
    }
    editableCaption(wrap, b, fig);
    wrap.appendChild(fig);
  }

  function renderTable(b, wrap) {
    var fig = document.createElement('figure');
    var table = document.createElement('table');
    [['thead', b.attributes.head || []], ['tbody', b.attributes.body || []]].forEach(function (part) {
      if (!part[1].length) {
        return;
      }
      var sec = document.createElement(part[0]);
      part[1].forEach(function (row) {
        var tr = document.createElement('tr');
        (row.cells || []).forEach(function (cell) {
          var c = document.createElement(cell.tag === 'th' || part[0] === 'thead' ? 'th' : 'td');
          c.contentEditable = 'true';
          c.innerHTML = cell.content || '';
          c.addEventListener('beforeinput', beforeTyping);
          c.addEventListener('input', function () { cell.content = cleanInline(c.innerHTML); scheduleSave(); });
          c.addEventListener('focus', function () { if (selected !== b.clientId) { select(b.clientId); } });
          tr.appendChild(c);
        });
        sec.appendChild(tr);
      });
      table.appendChild(sec);
    });
    fig.appendChild(table);
    editableCaption(wrap, b, fig);
    wrap.appendChild(fig);
  }

  function renderBlock(b) {
    var wrap = document.createElement('div');
    wrap.className = 'blk' + (b.isNew ? ' is-new' : '');
    wrap.setAttribute('data-block', b.clientId);
    wrap.setAttribute('data-type', b.name);
    if (TEXT_TYPES[b.name]) {
      renderText(b, wrap);
    } else if (b.name === 'core/image') {
      renderImage(b, wrap);
    } else if (b.name === 'core/table') {
      renderTable(b, wrap);
    } else {
      var div = document.createElement('div');
      div.className = 'blk-content';
      div.innerHTML = b.attributes.content || '';
      wrap.appendChild(div);
    }
    if (b.isNew) {
      var tag = document.createElement('span');
      tag.className = 'blk-tag';
      tag.textContent = 'Added by Stats Enhancer';
      wrap.appendChild(tag);
      setTimeout(function () { delete b.isNew; if (tag.parentNode) { tag.parentNode.removeChild(tag); } wrap.classList.remove('is-new'); }, 4000);
    }
    wrap.addEventListener('mousedown', function () { if (selected !== b.clientId) { select(b.clientId); } });
    return wrap;
  }

  function renderBlocks() {
    var host = $('#blocks');
    if (toolbar && toolbar.parentNode) {
      toolbar.parentNode.removeChild(toolbar);
    }
    host.innerHTML = '';
    doc.blocks.forEach(function (b) { host.appendChild(renderBlock(b)); });
    var last = doc.blocks[doc.blocks.length - 1];
    $('#appender').hidden = !!(last && last.name === 'core/paragraph' && !textOf(last.attributes.content));
    $('#appender').textContent = doc.blocks.length ? 'Type / to choose a block' : 'Type to start writing, or paste the article here';
    if (selected && indexOf(selected) >= 0) {
      select(selected);
    } else {
      selected = null;
    }
  }

  function insertAfter(id, blocks, focus) {
    pushHistory();
    var i = id ? indexOf(id) : doc.blocks.length - 1;
    Array.prototype.splice.apply(doc.blocks, [i + 1, 0].concat(blocks));
    renderBlocks();
    if (focus) {
      focusBlock(blocks[blocks.length - 1].clientId, true);
    }
    scheduleSave();
  }

  function removeBlock(id) {
    var i = indexOf(id);
    if (i < 0) {
      return;
    }
    pushHistory();
    doc.blocks.splice(i, 1);
    selected = null;
    renderBlocks();
    var prev = doc.blocks[Math.max(0, i - 1)];
    if (prev) {
      focusBlock(prev.clientId, true);
    }
    scheduleSave();
  }

  function move(id, dir) {
    var i = indexOf(id);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= doc.blocks.length) {
      return;
    }
    pushHistory();
    var b = doc.blocks.splice(i, 1)[0];
    doc.blocks.splice(j, 0, b);
    renderBlocks();
    focusBlock(id, true);
    scheduleSave();
  }

  function transform(id, target) {
    var i = indexOf(id);
    var b = doc.blocks[i];
    if (!b || !TEXT_TYPES[b.name]) {
      return;
    }
    pushHistory();
    var html = b.name === 'core/list'
      ? (b.attributes.values || '').replace(/<\/li>\s*<li>/g, '<br>').replace(/<\/?li>/g, '')
      : textHtml(b);
    var nb;
    if (/^h[2-4]$/.test(target)) {
      nb = mk('core/heading', { content: html, level: +target.charAt(1) });
    } else if (target === 'core/list') {
      nb = mk('core/list', { ordered: false, values: html.split(/<br\s*\/?>/).filter(function (x) { return textOf(x); }).map(function (x) { return '<li>' + x + '</li>'; }).join('') || '<li></li>' });
    } else if (target === 'core/quote') {
      nb = mk('core/quote', { value: html });
    } else {
      nb = para(html);
    }
    nb.clientId = b.clientId;
    doc.blocks[i] = nb;
    renderBlocks();
    focusBlock(nb.clientId, true);
    scheduleSave();
  }

  function splitBlock(b, el) {
    var s = window.getSelection();
    if (!s.rangeCount) {
      return;
    }
    var r = s.getRangeAt(0);
    r.deleteContents();
    var after = document.createRange();
    after.selectNodeContents(el);
    after.setStart(r.startContainer, r.startOffset);
    var holder = document.createElement('div');
    holder.appendChild(after.extractContents());
    readEditable(b, el);
    var nb = para(cleanInline(holder.innerHTML));
    pushHistory();
    var i = indexOf(b.clientId);
    doc.blocks.splice(i + 1, 0, nb);
    renderBlocks();
    focusBlock(nb.clientId, false);
    scheduleSave();
  }

  function mergeIntoPrevious(b, el) {
    var i = indexOf(b.clientId);
    var prev = doc.blocks[i - 1];
    if (!prev || (prev.name !== 'core/paragraph' && prev.name !== 'core/heading')) {
      return false;
    }
    readEditable(b, el);
    pushHistory();
    var before = prev.attributes.content || '';
    prev.attributes.content = before + (b.attributes.content || '');
    doc.blocks.splice(i, 1);
    renderBlocks();
    var w = blockEl(prev.clientId);
    var pe = w && w.querySelector('.blk-content');
    if (pe) {
      select(prev.clientId);
      pe.focus();
      var probe = document.createElement('div');
      probe.innerHTML = before;
      var offset = probe.textContent.length;
      var walker = document.createTreeWalker(pe, NodeFilter.SHOW_TEXT, null);
      var node;
      var rng = document.createRange();
      var placed = false;
      while ((node = walker.nextNode())) {
        if (offset <= node.nodeValue.length) {
          rng.setStart(node, offset);
          placed = true;
          break;
        }
        offset -= node.nodeValue.length;
      }
      if (!placed) {
        rng.selectNodeContents(pe);
        rng.collapse(false);
      }
      rng.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rng);
    }
    scheduleSave();
    return true;
  }

  function onKey(e, b, el) {
    var plain = b.name === 'core/paragraph' || b.name === 'core/heading';
    if (e.key === 'Enter' && !e.shiftKey && plain) {
      e.preventDefault();
      splitBlock(b, el);
      return;
    }
    if (e.key === 'Backspace' && caretAt(el, false)) {
      if (!textOf(el.innerHTML) && (plain || b.name === 'core/quote' || el.querySelectorAll('li').length <= 1)) {
        e.preventDefault();
        removeBlock(b.clientId);
        return;
      }
      if (plain && mergeIntoPrevious(b, el)) {
        e.preventDefault();
      }
      return;
    }
    var i = indexOf(b.clientId);
    if (e.key === 'ArrowUp' && caretAt(el, false) && i > 0) {
      e.preventDefault();
      focusBlock(doc.blocks[i - 1].clientId, true);
    } else if (e.key === 'ArrowDown' && caretAt(el, true) && i < doc.blocks.length - 1) {
      e.preventDefault();
      focusBlock(doc.blocks[i + 1].clientId, false);
    }
  }

  function clipboardBlocks(cd) {
    var html = cd.getData('text/html');
    var text = cd.getData('text/plain');
    var blocks = html ? htmlToBlocks(html) : plainToBlocks(text);
    if (!blocks.length && text) {
      blocks = plainToBlocks(text);
    }
    return { blocks: blocks, text: text };
  }

  function onPaste(e, b, el) {
    if (!e.clipboardData) {
      return;
    }
    var got = clipboardBlocks(e.clipboardData);
    var blocks = got.blocks;
    e.preventDefault();
    if (blocks.length <= 1 && (!blocks[0] || blocks[0].name === 'core/paragraph')) {
      var inline = blocks.length ? blocks[0].attributes.content : esc(got.text);
      document.execCommand('insertHTML', false, inline);
      return;
    }
    pushHistory();
    var i = indexOf(b.clientId);
    var replace = !textOf(el.innerHTML) && b.name === 'core/paragraph';
    Array.prototype.splice.apply(doc.blocks, [replace ? i : i + 1, replace ? 1 : 0].concat(blocks));
    renderBlocks();
    focusBlock(blocks[blocks.length - 1].clientId, true);
    scheduleSave();
    toast('Pasted ' + blocks.length + ' blocks');
  }

  function addBlockOfType(type) {
    var b;
    if (type === 'core/heading') {
      b = mk('core/heading', { content: '', level: 2 });
    } else if (type === 'core/list') {
      b = mk('core/list', { ordered: false, values: '<li></li>' });
    } else if (type === 'core/quote') {
      b = mk('core/quote', { value: '' });
    } else if (type === 'core/image') {
      b = mk('core/image', { url: '', alt: '', caption: '' });
    } else if (type === 'core/table') {
      var row = function (tag) { return { cells: [{ content: '', tag: tag }, { content: '', tag: tag }, { content: '', tag: tag }] }; };
      b = mk('core/table', { head: [row('th')], body: [row('td'), row('td')], caption: '' });
    } else {
      b = para('');
    }
    insertAfter(selected || (doc.blocks.length ? doc.blocks[doc.blocks.length - 1].clientId : null), [b], true);
    if (type === 'core/image') {
      var w = blockEl(b.clientId);
      var input = w && w.querySelector('input');
      if (input) {
        input.focus();
      }
    }
  }

  function closePopovers(except) {
    ['#inserter', '#drafts-menu', '#user-menu'].forEach(function (s) {
      if (s !== except) {
        $(s).hidden = true;
      }
    });
    $('#tb-inserter').classList.toggle('is-open', except === '#inserter' && !$('#inserter').hidden);
  }

  function togglePopover(sel) {
    var el = $(sel);
    var open = el.hidden;
    closePopovers(sel);
    el.hidden = !open;
    $('#tb-inserter').classList.toggle('is-open', sel === '#inserter' && open);
  }

  function renderDrafts() {
    var list = $('#drafts-list');
    list.innerHTML = '';
    draftIndex().forEach(function (d) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '?draft=' + encodeURIComponent(d.id);
      a.className = d.id === doc.id ? 'is-current' : '';
      a.innerHTML = '<span class="d-title"></span><small></small>';
      a.querySelector('.d-title').textContent = d.title || 'Untitled draft';
      a.querySelector('small').textContent = new Date(d.updated).toLocaleString();
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', function () {
        if (!window.confirm('Delete "' + (d.title || 'Untitled draft') + '"? This cannot be undone.')) {
          return;
        }
        store.remove(KEY_DRAFT + d.id);
        store.set(KEY_INDEX, draftIndex().filter(function (x) { return x.id !== d.id; }));
        if (d.id === doc.id) {
          var rest = draftIndex();
          openDraft(rest.length ? rest[0].id : createDraft().id);
        } else {
          renderDrafts();
        }
      });
      li.appendChild(a);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function createDraft() {
    var d = newDraft();
    store.set(KEY_DRAFT + d.id, d);
    var idx = draftIndex();
    idx.unshift({ id: d.id, title: 'Untitled draft', updated: d.updated });
    store.set(KEY_INDEX, idx.slice(0, 50));
    return d;
  }

  function renderCategories() {
    var host = $('#cat-list');
    host.innerHTML = '';
    CATEGORIES.forEach(function (c) {
      var label = document.createElement('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = doc.categories.indexOf(c.name) >= 0;
      box.addEventListener('change', function () {
        doc.categories = doc.categories.filter(function (x) { return x !== c.name; });
        if (box.checked) {
          doc.categories.push(c.name);
        }
        scheduleSave();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(c.name));
      if (!c.covered) {
        var off = document.createElement('span');
        off.className = 'cat-off';
        off.textContent = '(not covered yet)';
        label.appendChild(off);
      }
      host.appendChild(label);
    });
    $('#cat-other').value = doc.catOther || '';
    $('#post-tags').value = doc.tags || '';
    $('#post-date').value = doc.date || today();
  }

  function applyImport(data) {
    pushHistory();
    doc.title = data.title || doc.title;
    doc.blocks = htmlToBlocks(data.content || '');
    if (data.date) {
      doc.date = data.date;
    }
    var known = CATEGORIES.map(function (c) { return c.name.toLowerCase(); });
    doc.categories = [];
    var other = [];
    (data.categories || []).forEach(function (c) {
      var k = known.indexOf(String(c).toLowerCase());
      if (k >= 0) {
        doc.categories.push(CATEGORIES[k].name);
      } else if (!/^news$/i.test(c)) {
        other.push(c);
      }
    });
    doc.catOther = other.join(', ');
    doc.tags = (data.tags || []).join(', ');
    doc.jobId = '';
    doc.used = [];
    doc.source = data.url || '';
    saveDraft();
  }

  function preview() {
    var body = $('#preview-body');
    body.innerHTML = '<h1></h1>' + postContent();
    body.querySelector('h1').textContent = doc.title || 'Untitled draft';
    $('#preview').hidden = false;
    $('#preview').scrollTop = 0;
  }

  function installShim() {
    window.wp = {
      blocks: {
        createBlock: function (name, attrs) {
          var b = mk(name, normalizeAttrs(name, attrs || {}));
          b.isNew = true;
          return b;
        },
        getBlockContent: function (b) { return serialize(b); }
      },
      data: {
        select: function (storeName) {
          if (storeName === 'core/editor') {
            return {
              getEditedPostAttribute: function (k) {
                if (k === 'title') { return doc.title; }
                if (k === 'categories') { return categoryList(); }
                if (k === 'tags') { return tagList(); }
                return null;
              },
              getEditedPostContent: postContent
            };
          }
          if (storeName === 'core/block-editor') {
            return {
              getBlocks: function () { return doc.blocks; },
              getSelectedBlockClientId: function () { return selected; },
              getBlockHierarchyRootClientId: function (id) { return id; },
              getBlockIndex: function (id) { return indexOf(id); }
            };
          }
          return null;
        },
        dispatch: function () {
          return {
            insertBlocks: function (blocks, index) {
              var list = Array.isArray(blocks) ? blocks : [blocks];
              pushHistory();
              var at = typeof index === 'number' ? Math.max(0, Math.min(index, doc.blocks.length)) : doc.blocks.length;
              Array.prototype.splice.apply(doc.blocks, [at, 0].concat(list));
              renderBlocks();
              select(list[0].clientId);
              scheduleSave();
            },
            selectBlock: function (id) { select(id); }
          };
        }
      }
    };
    window.StatsEnhancer = {
      ajaxUrl: AJAX, nonce: 'test-site', postId: doc.id, jobId: doc.jobId || '', blockEditor: true, used: doc.used || []
    };
    var realFetch = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      if (url !== AJAX || !opts || !(opts.body instanceof FormData)) {
        return realFetch(url, opts);
      }
      var fd = opts.body;
      var action = fd.get('action');
      if (action === 'stats_enhancer_start') {
        fd.set('date', doc.date || today());
      }
      return realFetch(url, opts).then(function (res) {
        if (res.status === 401) {
          showSignin('Your session ended. Sign in again to keep testing.');
        }
        res.clone().json().then(function (j) {
          if (!j || !j.success) {
            return;
          }
          if (action === 'stats_enhancer_start' && j.data && j.data.job_id) {
            doc.jobId = j.data.job_id;
            saveDraft();
          }
          if (action === 'stats_enhancer_insert_image' || action === 'stats_enhancer_log_insert') {
            doc.used.push({ job_id: fd.get('job_id'), addon_id: fd.get('addon_id') });
            saveDraft();
          }
        }).catch(function () { return null; });
        return res;
      });
    };
  }

  function loadPanel() {
    if (panelLoaded) {
      return;
    }
    panelLoaded = true;
    var s = document.createElement('script');
    s.src = '/assets/plugin/panel.js';
    document.body.appendChild(s);
  }

  function bindUi() {
    var title = $('#post-title');
    title.addEventListener('beforeinput', beforeTyping);
    title.addEventListener('input', function () {
      doc.title = title.value.replace(/\s*\n\s*/g, ' ');
      sizeTitle();
      scheduleSave();
    });
    title.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (doc.blocks.length) {
          focusBlock(doc.blocks[0].clientId, false);
        } else {
          insertAfter(null, [para('')], true);
        }
      }
    });
    title.addEventListener('paste', function (e) {
      var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (text.indexOf('\n') < 0) {
        return;
      }
      e.preventDefault();
      var got = clipboardBlocks(e.clipboardData);
      var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
      pushHistory();
      doc.title = lines[0] || '';
      title.value = doc.title;
      var rest = got.blocks;
      if (rest.length && textOf(serialize(rest[0])) === doc.title) {
        rest = rest.slice(1);
      }
      Array.prototype.push.apply(doc.blocks, rest);
      sizeTitle();
      renderBlocks();
      scheduleSave();
      toast('Pasted the title and ' + rest.length + ' blocks');
    });

    var appender = $('#appender');
    appender.addEventListener('click', function () { insertAfter(doc.blocks.length ? doc.blocks[doc.blocks.length - 1].clientId : null, [para('')], true); });
    appender.addEventListener('keydown', function (e) {
      if (e.key.length === 1 || e.key === 'Enter') {
        e.preventDefault();
        var start = e.key.length === 1 && e.key !== '/' ? esc(e.key) : '';
        insertAfter(doc.blocks.length ? doc.blocks[doc.blocks.length - 1].clientId : null, [para(start)], true);
        if (e.key === '/') {
          togglePopover('#inserter');
        }
      }
    });
    appender.addEventListener('paste', function (e) {
      if (!e.clipboardData) {
        return;
      }
      e.preventDefault();
      var blocks = clipboardBlocks(e.clipboardData).blocks;
      if (!blocks.length) {
        return;
      }
      insertAfter(doc.blocks.length ? doc.blocks[doc.blocks.length - 1].clientId : null, blocks, true);
      toast('Pasted ' + blocks.length + ' blocks');
    });

    $('#tb-inserter').addEventListener('click', function (e) { e.stopPropagation(); togglePopover('#inserter'); });
    $all('#inserter [data-insert]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        closePopovers();
        addBlockOfType(btn.getAttribute('data-insert'));
      });
    });
    $('#tb-drafts').addEventListener('click', function (e) { e.stopPropagation(); renderDrafts(); togglePopover('#drafts-menu'); });
    $('#new-draft').addEventListener('click', function () { saveDraft(); openDraft(createDraft().id); });
    $('#tb-user').addEventListener('click', function (e) { e.stopPropagation(); togglePopover('#user-menu'); });
    $('#signout').addEventListener('click', function () {
      fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' }).finally(function () { window.location.reload(); });
    });
    $('#tb-undo').addEventListener('click', undo);
    $('#tb-redo').addEventListener('click', redo);
    $('#tb-save').addEventListener('click', function () { saveDraft(); toast('Draft saved in this browser'); });
    $('#tb-preview').addEventListener('click', preview);
    $('#preview-close').addEventListener('click', function () { $('#preview').hidden = true; });
    $('#tb-settings').addEventListener('click', function () {
      var sb = $('#sidebar');
      sb.hidden = !sb.hidden;
      this.classList.toggle('is-pressed', !sb.hidden);
      this.setAttribute('aria-pressed', String(!sb.hidden));
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#inserter, #drafts-menu, #user-menu, #tb-inserter, #tb-drafts, #tb-user')) {
        closePopovers();
      }
      if (!e.target.closest('.blk, .blk-toolbar, #se-panel, #sidebar, .topbar, #inserter') && e.target.closest('.canvas') && !e.target.closest('#post-title, #appender')) {
        select(null);
      }
    });
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        closePopovers();
        $('#preview').hidden = true;
      }
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveDraft();
        toast('Draft saved in this browser');
      }
    });

    $('#cat-other').addEventListener('input', function () { doc.catOther = this.value; scheduleSave(); });
    $('#post-tags').addEventListener('input', function () { doc.tags = this.value; scheduleSave(); });
    $('#post-date').addEventListener('change', function () { doc.date = this.value || today(); scheduleSave(); });

    $('#import-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var url = $('#import-url').value.trim();
      var msg = $('#import-msg');
      if (doc.blocks.length && !window.confirm('Replace the article in the editor with the imported one?')) {
        return;
      }
      $('#import-btn').disabled = true;
      msg.hidden = false;
      msg.className = 'sb-msg';
      msg.textContent = 'Importing…';
      fetch('/api/import?url=' + encodeURIComponent(url), { credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
        .then(function (res) {
          if (res.status === 401) {
            showSignin('Your session ended. Sign in again to keep testing.');
            return;
          }
          if (!res.ok) {
            throw new Error(res.j.error || 'Import failed.');
          }
          applyImport(res.j);
          window.location.reload();
        })
        .catch(function (err) {
          msg.className = 'sb-msg is-error';
          msg.textContent = err.message;
          $('#import-btn').disabled = false;
        });
    });
  }

  function startApp(name) {
    var params = new URLSearchParams(window.location.search);
    var wanted = params.get('draft');
    doc = loadDraft(wanted);
    if (!doc) {
      var idx = draftIndex();
      doc = (!wanted && idx.length && loadDraft(idx[0].id)) || createDraft();
      if (wanted !== doc.id) {
        var u = new URL(window.location.href);
        u.searchParams.set('draft', doc.id);
        window.history.replaceState(null, '', u.toString());
      }
    }
    $('#boot').hidden = true;
    $('#signin').hidden = true;
    $('#app').hidden = false;
    $('#tb-user').textContent = name;
    if (window.innerWidth < 960) {
      $('#sidebar').hidden = true;
      $('#tb-settings').classList.remove('is-pressed');
      $('#tb-settings').setAttribute('aria-pressed', 'false');
    }
    $('#post-title').value = doc.title || '';
    $('#tb-doc').textContent = doc.title || 'Untitled draft';
    renderCategories();
    renderBlocks();
    sizeTitle();
    updateUndo();
    if (!panelLoaded) {
      bindUi();
      installShim();
      loadPanel();
    }
    window.addEventListener('beforeunload', saveDraft);
  }

  function showSignin(message) {
    $('#boot').hidden = true;
    $('#signin').hidden = false;
    var err = $('#signin-error');
    err.hidden = !message;
    err.textContent = message || '';
    setTimeout(function () { $('#signin-code').focus(); }, 50);
  }

  function boot() {
    $('#signin-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = this.querySelector('button');
      btn.disabled = true;
      fetch('/api/session', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: $('#signin-code').value })
      }).then(function (r) { return r.json(); }).then(function (j) {
        btn.disabled = false;
        if (!j.signedIn) {
          showSignin(j.error || 'That code is not valid.');
          return;
        }
        if (panelLoaded) {
          $('#signin').hidden = true;
          return;
        }
        startApp(j.name);
      }).catch(function () {
        btn.disabled = false;
        showSignin('Could not reach the test site. Check your connection and try again.');
      });
    });
    fetch('/api/session', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.signedIn) {
          startApp(s.name);
        } else {
          showSignin('');
        }
      })
      .catch(function () { showSignin('Could not reach the test site. Reload the page to try again.'); });
  }

  boot();
})();
