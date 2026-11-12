/* =========================================================
   设计方案全文渲染
   把页面内嵌的 Markdown（<script type="text/markdown">）转为排版好的 HTML，
   并生成侧边目录、阅读进度与滚动高亮。零外部依赖。
   ========================================================= */
(function () {
  'use strict';

  var srcEl = document.getElementById('md-source');
  var out = document.getElementById('docContent');
  var tocEl = document.getElementById('docToc');
  var progress = document.getElementById('progress');
  if (!srcEl || !out) { return; }

  var src = srcEl.textContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function splitRow(line) {
    var t = line.trim();
    if (t.charAt(0) === '|') { t = t.slice(1); }
    if (t.charAt(t.length - 1) === '|') { t = t.slice(0, -1); }
    return t.split('|').map(function (c) { return c.trim(); });
  }

  function isTableSep(line) {
    return line.indexOf('|') !== -1 && line.indexOf('-') !== -1 && /^[\s|:-]+$/.test(line);
  }

  function isBlockStart(line) {
    return /^(#{1,4})\s+/.test(line) ||
      /^\s*\|/.test(line) ||
      /^>\s?/.test(line) ||
      /^\d+\.\s+/.test(line) ||
      /^[-*]\s+/.test(line);
  }

  function render() {
    var lines = src.split('\n');
    var html = [];
    var toc = [];
    var h2Count = 0;
    var h3Count = 0;
    var tableCount = 0;
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      var hm = line.match(/^(#{1,4})\s+(.*)$/);
      if (hm) {
        var level = hm[1].length;
        var text = hm[2].trim();
        if (level === 1) {
          i++;
          continue; // 标题在页首大幅呈现，正文不再重复
        }
        if (level === 2) {
          h2Count++;
          h3Count = 0;
          var id2 = 's' + h2Count;
          toc.push({ level: 2, id: id2, text: text });
          html.push('<h2 id="' + id2 + '">' + inline(text) + '</h2>');
        } else if (level === 3) {
          h3Count++;
          var num = text.match(/^(\d+)\.(\d+)/);
          var id3 = num ? ('s' + num[1] + '-' + num[2]) : ('s' + h2Count + '-' + h3Count);
          toc.push({ level: 3, id: id3, text: text });
          html.push('<h3 id="' + id3 + '">' + inline(text) + '</h3>');
        } else {
          html.push('<h4>' + inline(text) + '</h4>');
        }
        i++;
        continue;
      }

      if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var tableLines = [line];
        var j = i + 1;
        while (j < lines.length && /^\s*\|/.test(lines[j])) {
          tableLines.push(lines[j]);
          j++;
        }
        var headerCells = splitRow(tableLines[0]);
        var bodyStart = 2; // 0 表头 / 1 分隔行
        var thead = '<thead><tr>' + headerCells.map(function (c) {
          return '<th>' + inline(c) + '</th>';
        }).join('') + '</tr></thead>';
        var tbodyRows = [];
        for (var r = bodyStart; r < tableLines.length; r++) {
          var cells = splitRow(tableLines[r]);
          tbodyRows.push('<tr>' + cells.map(function (c) {
            return '<td>' + inline(c) + '</td>';
          }).join('') + '</tr>');
        }
        tableCount++;
        if (tableCount === 1) {
          html.push('<p class="table-hint">表格可左右滑动查看完整内容</p>');
        }
        html.push('<div class="table-wrap"><table>' + thead +
          (tbodyRows.length ? '<tbody>' + tbodyRows.join('') + '</tbody>' : '') +
          '</table></div>');
        i = j;
        continue;
      }

      if (/^>\s?/.test(line)) {
        var quotes = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quotes.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        html.push('<blockquote><p>' + quotes.map(inline).join('<br>') + '</p></blockquote>');
        continue;
      }

      var ordered = /^\d+\.\s+/.test(line);
      if (ordered || /^[-*]\s+/.test(line)) {
        var itemRe = ordered ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/;
        var items = [];
        while (i < lines.length && itemRe.test(lines[i])) {
          items.push(lines[i].match(itemRe)[1]);
          i++;
        }
        var tag = ordered ? 'ol' : 'ul';
        html.push('<' + tag + '>' + items.map(function (t) {
          return '<li>' + inline(t) + '</li>';
        }).join('') + '</' + tag + '>');
        continue;
      }

      var para = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      if (para.length) {
        html.push('<p>' + inline(para.join(' ')) + '</p>');
      } else {
        i++;
      }
    }

    out.innerHTML = html.join('\n');

    if (tocEl) {
      var frag = document.createDocumentFragment();
      toc.forEach(function (item) {
        var a = document.createElement('a');
        a.href = '#' + item.id;
        a.textContent = item.text;
        if (item.level === 3) { a.className = 'toc-sub'; }
        frag.appendChild(a);
      });
      tocEl.appendChild(frag);
    }

    initSpy(toc);
  }

  function initSpy(tocItems) {
    if (!tocEl || !tocItems.length) { return; }
    var headings = tocItems.map(function (t) {
      return { id: t.id, el: document.getElementById(t.id), link: null };
    }).filter(function (h) { return !!h.el; });
    if (!headings.length) { return; }

    Array.prototype.forEach.call(tocEl.querySelectorAll('a'), function (a) {
      var id = a.getAttribute('href').slice(1);
      headings.forEach(function (h) { if (h.id === id) { h.link = a; } });
    });

    var ticking = false;

    function update() {
      ticking = false;
      var offset = 130;
      var active = headings[0];
      for (var k = 0; k < headings.length; k++) {
        if (headings[k].el.getBoundingClientRect().top - offset <= 0) {
          active = headings[k];
        }
      }
      headings.forEach(function (h) {
        if (!h.link) { return; }
        h.link.classList.toggle('active', h === active);
      });

      if (progress) {
        var docH = document.documentElement.scrollHeight - window.innerHeight;
        var pct = docH > 0 ? (window.scrollY / docH) * 100 : 0;
        progress.style.width = Math.max(0, Math.min(100, pct)) + '%';
      }
    }

    function onScroll() {
      if (ticking) { return; }
      ticking = true;
      window.requestAnimationFrame(update);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
  }

  try {
    render();
  } catch (err) {
    out.innerHTML = '';
    var pre = document.createElement('pre');
    pre.className = 'doc-fallback';
    pre.textContent = src;
    out.appendChild(pre);
  }

  var printBtn = document.getElementById('printBtn');
  if (printBtn) {
    printBtn.addEventListener('click', function () { window.print(); });
  }
})();
