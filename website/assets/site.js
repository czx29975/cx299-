/* =========================================================
   方案页 / 文档页共用交互
   适老化开关、导航、入场动效、语音脚本演示
   （应用页请使用 app.js）
   ========================================================= */
(function () {
  'use strict';

  var root = document.documentElement;
  window.addEventListener('error', function () { root.classList.remove('js'); });

  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  };

  /* ---------- 适老化 ---------- */
  var seniorToggle = document.getElementById('seniorToggle');
  var contrastToggle = document.getElementById('contrastToggle');
  var a11yBtn = document.getElementById('a11yBtn');
  var a11yPanel = document.getElementById('a11yPanel');
  var seniorOn = store.get('ay.senior') === '1';
  var contrastOn = store.get('ay.contrast') === '1';

  function applyA11y() {
    root.classList.toggle('senior', seniorOn);
    root.classList.toggle('hc', contrastOn);
    if (seniorToggle) { seniorToggle.checked = seniorOn; }
    if (contrastToggle) { contrastToggle.checked = contrastOn; }
  }
  applyA11y();

  if (seniorToggle) {
    seniorToggle.addEventListener('change', function () {
      seniorOn = seniorToggle.checked;
      store.set('ay.senior', seniorOn ? '1' : '0');
      applyA11y();
    });
  }
  if (contrastToggle) {
    contrastToggle.addEventListener('change', function () {
      contrastOn = contrastToggle.checked;
      store.set('ay.contrast', contrastOn ? '1' : '0');
      applyA11y();
    });
  }

  function closeA11y() {
    if (!a11yPanel || !a11yBtn) { return; }
    a11yPanel.hidden = true;
    a11yBtn.setAttribute('aria-expanded', 'false');
  }

  if (a11yBtn && a11yPanel) {
    a11yBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = a11yPanel.hidden;
      a11yPanel.hidden = !open;
      a11yBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    a11yPanel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', closeA11y);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeA11y(); }
    });
  }

  /* ---------- 导航 ---------- */
  var topbar = document.getElementById('topbar');
  var menuBtn = document.getElementById('menuBtn');
  var mobileMenu = document.getElementById('mobileMenu');

  function onScroll() {
    if (topbar) { topbar.classList.toggle('is-scrolled', window.scrollY > 8); }
  }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  function setMenu(open) {
    if (!menuBtn || !mobileMenu) { return; }
    mobileMenu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  }
  if (menuBtn && mobileMenu) {
    menuBtn.addEventListener('click', function () { setMenu(mobileMenu.hidden); });
    mobileMenu.addEventListener('click', function (e) {
      if (e.target.closest('a')) { setMenu(false); }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 920) { setMenu(false); }
    });
  }

  var navLinks = [].slice.call(document.querySelectorAll('.nav a[href^="#"]'));
  var sections = navLinks.map(function (a) {
    return document.querySelector(a.getAttribute('href'));
  }).filter(Boolean);
  if ('IntersectionObserver' in window && sections.length) {
    var navObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) { return; }
        navLinks.forEach(function (a) {
          a.classList.toggle('is-active', a.getAttribute('href') === '#' + entry.target.id);
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
    sections.forEach(function (s) { navObserver.observe(s); });
  }

  /* ---------- 入场动效 ---------- */
  var reveals = [].slice.call(document.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window && reveals.length) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function (el) { revealObserver.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  var yearEl = document.getElementById('year');
  if (yearEl) { yearEl.textContent = String(new Date().getFullYear()); }

  /* ---------- 语音脚本演示（仅方案页） ---------- */
  var SCRIPTS = {
    vague: {
      title: '模糊指代', sub: '“那个白色的药”',
      lines: [
        { kind: 'elder', text: '那个……小助手啊，我那个白色的、早上吃的药，是不是该吃了？' },
        { kind: 'ai', text: '王阿姨，您说的是早上八点吃一片的降压药。您吃过了吗？' },
        { kind: 'elder', text: '没呢。' },
        { kind: 'ai', text: '好。药盒在餐桌左边第二个格子，您吃完跟我说一声“吃过了”，我给您记上。' }
      ]
    },
    medicine: {
      title: '服药提醒', sub: '提醒不是闹钟，是闭环',
      lines: [
        { kind: 'ai', text: '王阿姨，八点了，该吃早上的降压药啦，一片。' },
        { kind: 'elder', text: '晓得了。' },
        { kind: 'ai', text: '那您吃完跟我说一声“吃过了”，我给您记上。' },
        { kind: 'stage', text: '（5 分钟没有确认）' },
        { kind: 'ai', text: '王阿姨，药吃了吗？我帮您记一下。' },
        { kind: 'elder', text: '哎呀忘了，这就去。' },
        { kind: 'ai', text: '不着急，我等您。' },
        { kind: 'elder', text: '吃过了。' },
        { kind: 'ai', text: '好，记上了。今天早上八点零七分，已服用。' }
      ]
    },
    fall: {
      title: '疑似跌倒', sub: '先确认，再叫人来',
      lines: [
        { kind: 'ai', text: '王阿姨，我听到响动，您还好吗？能答应我一声吗？' },
        { kind: 'stage', text: '（45 秒无应答）' },
        { kind: 'ai', text: '我先给李女士打电话了，您别着急，先别起身，我陪着您。' },
        { kind: 'note', text: '家属端同时收到：疑似跌倒 · 详细地址 · 应急信息卡 · 一键回拨 / 呼叫网格员 / 呼叫 120。' },
        { kind: 'note', text: '家属 60 秒未接 → 自动转社区值班；3 分钟未闭环 → 按预案联系 120，人工坐席介入。' }
      ]
    },
    family: {
      title: '想孩子了', sub: '一句话就接通',
      lines: [
        { kind: 'elder', text: '小助手，我想闺女了。' },
        { kind: 'ai', text: '我这就给李女士打视频。要是她没接，我帮您留句话，好吗？' },
        { kind: 'stage', text: '（通话结束后）' },
        { kind: 'ai', text: '今天聊了六分钟。要不要我把周六她来看您记到日程里？' }
      ]
    },
    scam: {
      title: '防诈骗', sub: '不判断真假，只挡住动作',
      lines: [
        { kind: 'caller', text: '妈，我换号了，把收到的验证码念给我……' },
        { kind: 'ai', text: '王阿姨，涉及验证码的电话，我不能帮您转述，也建议先别念。要不要我直接拨给李女士本人核一下？' },
        { kind: 'note', text: '助手不判断真假，只阻断高风险动作，并提供一条更安全的路径。' }
      ]
    }
  };

  var tabsWrap = document.getElementById('demoTabs');
  var log = document.getElementById('demoLog');
  var playBtn = document.getElementById('demoPlay');
  var stopBtn = document.getElementById('demoStop');
  var demoHint = document.getElementById('demoHint');

  if (tabsWrap && log && playBtn) {
    var currentKey = Object.keys(SCRIPTS)[0];
    var playToken = 0;
    var playing = false;
    var synth = ('speechSynthesis' in window) ? window.speechSynthesis : null;
    var zhVoice = null;
    var renderTimers = [];

    function pickVoice() {
      if (!synth) { return null; }
      if (zhVoice) { return zhVoice; }
      var voices = [];
      try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
      for (var i = 0; i < voices.length; i++) {
        if (/zh[-_]?CN|zh[-_]?Hans|Chinese|中文|普通话/i.test(voices[i].lang + ' ' + voices[i].name)) {
          zhVoice = voices[i];
          break;
        }
      }
      return zhVoice;
    }
    if (synth) {
      if (typeof synth.addEventListener === 'function') {
        synth.addEventListener('voiceschanged', function () { zhVoice = null; pickVoice(); });
      }
      pickVoice();
    }

    function wait(ms) {
      return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
    }

    function speak(text, rate) {
      return new Promise(function (resolve) {
        if (!synth) {
          window.setTimeout(resolve, Math.min(6500, Math.max(1400, text.length * 190)));
          return;
        }
        var settled = false;
        function finish() {
          if (settled) { return; }
          settled = true;
          resolve();
        }
        try {
          var utter = new window.SpeechSynthesisUtterance(text);
          utter.lang = 'zh-CN';
          utter.rate = rate;
          utter.pitch = 1;
          var voice = pickVoice();
          if (voice) { utter.voice = voice; }
          utter.onend = finish;
          utter.onerror = finish;
          window.setTimeout(finish, Math.min(22000, Math.max(2600, text.length * 360)));
          synth.speak(utter);
        } catch (e) {
          window.setTimeout(finish, 1800);
        }
      });
    }

    function setPlayText(text) {
      playBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-play"/></svg>' + text;
    }

    function stopPlayback() {
      playToken++;
      playing = false;
      if (synth) { try { synth.cancel(); } catch (e) {} }
      renderTimers.forEach(function (t) { window.clearTimeout(t); });
      renderTimers = [];
      log.querySelectorAll('.msg.speaking').forEach(function (el) { el.classList.remove('speaking'); });
      setPlayText('朗读示例');
      if (stopBtn) { stopBtn.hidden = true; }
    }

    function scrollLogTo(el) {
      var top = el.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 16;
      if (typeof log.scrollTo === 'function') {
        log.scrollTo({ top: top, behavior: 'smooth' });
      } else {
        log.scrollTop = top;
      }
    }

    function renderScript(key, animate) {
      var data = SCRIPTS[key];
      if (!data) { return; }
      currentKey = key;
      renderTimers.forEach(function (t) { window.clearTimeout(t); });
      renderTimers = [];
      log.innerHTML = '';

      data.lines.forEach(function (line, index) {
        var el = document.createElement('div');
        var bubble;
        el.dataset.kind = line.kind;

        if (line.kind === 'note') {
          el.className = 'msg note';
          el.textContent = line.text;
        } else if (line.kind === 'stage') {
          el.className = 'msg stage';
          var span = document.createElement('span');
          span.textContent = line.text;
          el.appendChild(span);
        } else {
          el.className = 'msg ' + line.kind;
          var avatar = document.createElement('span');
          avatar.className = 'avatar';
          avatar.textContent = line.kind === 'ai' ? '安' : (line.kind === 'elder' ? '王' : '来');
          bubble = document.createElement('div');
          bubble.className = 'bubble';
          bubble.textContent = line.text;
          if (line.kind === 'elder') {
            el.appendChild(bubble);
            el.appendChild(avatar);
          } else {
            el.appendChild(avatar);
            el.appendChild(bubble);
          }
          el.dataset.text = line.text;
        }

        log.appendChild(el);

        if (animate !== false) {
          var timer = window.setTimeout(function () { el.classList.add('show'); }, 60 + index * 70);
          renderTimers.push(timer);
        } else {
          el.classList.add('show');
        }
      });
      log.scrollTop = 0;
      if (demoHint) { demoHint.textContent = data.lines.length + ' 句对话'; }
    }

    async function playScript() {
      stopPlayback();
      var token = ++playToken;
      playing = true;
      setPlayText('朗读中…');
      if (stopBtn) { stopBtn.hidden = false; }
      var msgs = [].slice.call(log.querySelectorAll('.msg'));
      msgs.forEach(function (m) { m.classList.remove('show', 'speaking'); });
      await wait(200);

      for (var i = 0; i < msgs.length; i++) {
        if (token !== playToken) { return; }
        var m = msgs[i];
        m.classList.add('show');
        scrollLogTo(m);
        if (m.dataset.kind === 'stage' || m.dataset.kind === 'note') {
          await wait(1150);
          continue;
        }
        m.classList.add('speaking');
        await speak(m.dataset.text || '', m.dataset.kind === 'caller' ? 0.95 : 0.82);
        m.classList.remove('speaking');
        if (token !== playToken) { return; }
        await wait(240);
      }

      if (token === playToken) {
        playing = false;
        setPlayText('再读一遍');
        if (stopBtn) { stopBtn.hidden = true; }
      }
    }

    function selectTab(key, focus) {
      var tabs = [].slice.call(tabsWrap.querySelectorAll('.demo-tab'));
      tabs.forEach(function (t) {
        var selected = t.dataset.script === key;
        t.setAttribute('aria-selected', selected ? 'true' : 'false');
        t.setAttribute('tabindex', selected ? '0' : '-1');
        if (selected && focus) { t.focus(); }
      });
      stopPlayback();
      renderScript(key, true);
    }

    tabsWrap.addEventListener('click', function (e) {
      var tab = e.target.closest('.demo-tab');
      if (!tab) { return; }
      selectTab(tab.dataset.script, false);
    });

    tabsWrap.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft') { return; }
      e.preventDefault();
      var tabs = [].slice.call(tabsWrap.querySelectorAll('.demo-tab'));
      var index = tabs.indexOf(document.activeElement);
      if (index < 0) { return; }
      var step = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
      selectTab(tabs[(index + step + tabs.length) % tabs.length].dataset.script, true);
    });

    playBtn.addEventListener('click', function () {
      if (playing) { stopPlayback(); return; }
      playScript();
    });
    if (stopBtn) {
      stopBtn.addEventListener('click', function () { stopPlayback(); });
    }

    renderScript(currentKey, true);
    window.addEventListener('pagehide', stopPlayback);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopPlayback(); }
    });
  }
})();
