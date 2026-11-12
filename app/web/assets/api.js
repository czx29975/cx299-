/* 安语 · 前端公共能力：请求、提示、弹窗、语音 */
(function () {
  'use strict';

  window.$ = function (s, r) { return (r || document).querySelector(s); };
  window.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  window.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  window.hhmm = function (iso) {
    if (!iso) { return ''; }
    var m = String(iso).match(/(\d{2}):(\d{2})/);
    return m ? m[1] + ':' + m[2] : String(iso);
  };

  window.relTime = function (iso) {
    if (!iso) { return ''; }
    var t = new Date(String(iso).replace(' ', 'T')).getTime();
    if (isNaN(t)) { return String(iso); }
    var d = Math.round((Date.now() - t) / 1000);
    if (d < 60) { return '刚刚'; }
    if (d < 3600) { return Math.floor(d / 60) + ' 分钟前'; }
    if (d < 86400) { return Math.floor(d / 3600) + ' 小时前'; }
    return Math.floor(d / 86400) + ' 天前';
  };

  function ApiError(message, status) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status;
  }
  ApiError.prototype = Object.create(Error.prototype);

  window.API = {
    async req(path, opts) {
      opts = opts || {};
      var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
      if (opts.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      var res;
      try {
        res = await fetch(path, init);
      } catch (e) {
        throw new ApiError('网络不通，请检查服务是否还在运行', 0);
      }
      var data = {};
      try { data = await res.json(); } catch (e) { /* 空响应 */ }
      if (!res.ok) {
        if (res.status === 401 && !opts.silent) { location.href = '/login.html'; }
        throw new ApiError(data.error || ('请求失败（' + res.status + '）'), res.status);
      }
      return data;
    },
    get(p, o) { return this.req(p, o); },
    post(p, body, o) { return this.req(p, Object.assign({ method: 'POST', body: body || {} }, o || {})); }
  };

  window.toast = function (msg, kind) {
    var wrap = $('#toastWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toastWrap';
      wrap.className = 'toast-wrap';
      wrap.setAttribute('aria-live', 'polite');
      document.body.appendChild(wrap);
    }
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function () { el.remove(); }, 320);
    }, kind === 'err' ? 4200 : 2600);
  };

  /* 通用确认弹窗，返回 Promise<boolean> */
  window.confirmBox = function (opts) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'backdrop';
      back.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle">' +
          '<h2 id="mTitle">' + esc(opts.title || '请确认') + '</h2>' +
          '<div class="modal-body">' + (opts.html || esc(opts.text || '')) + '</div>' +
          '<div class="modal-actions">' +
            '<button class="btn btn-ghost" data-no>' + esc(opts.cancel || '取消') + '</button>' +
            '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-yes>' +
              esc(opts.ok || '确定') + '</button>' +
          '</div>' +
        '</div>';
      function done(v) {
        document.removeEventListener('keydown', onKey);
        back.remove();
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') { done(false); } }
      back.addEventListener('click', function (e) {
        if (e.target === back || e.target.hasAttribute('data-no')) { done(false); }
        if (e.target.hasAttribute('data-yes')) { done(true); }
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      var btn = back.querySelector('[data-yes]');
      if (btn) { btn.focus(); }
    });
  };

  /* ---------------- 语音 ---------------- */

  var voiceCache = null;
  function pickVoice() {
    if (!window.speechSynthesis) { return null; }
    var vs = window.speechSynthesis.getVoices() || [];
    if (!vs.length) { return null; }
    if (voiceCache) { return voiceCache; }
    voiceCache = vs.filter(function (v) { return /zh[-_]CN|Chinese|普通话/i.test(v.lang + v.name); })[0] || vs[0];
    return voiceCache;
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = function () { voiceCache = null; pickVoice(); };
  }

  window.speak = function (text, opts) {
    opts = opts || {};
    if (!window.speechSynthesis || !text) { return false; }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text));
      var v = pickVoice();
      if (v) { u.voice = v; }
      u.lang = 'zh-CN';
      u.rate = opts.rate || 0.92;
      u.pitch = 1;
      window.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  };

  window.stopSpeak = function () {
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) {} }
  };

  window.voiceSupported = function () {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  };

  /* 识别一句话；返回 {stop()} */
  window.listen = function (handlers) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { handlers.onError && handlers.onError('unsupported'); return null; }
    var r = new SR();
    r.lang = 'zh-CN';
    r.interimResults = true;
    r.continuous = !!handlers.continuous;
    r.maxAlternatives = 1;
    var finalText = '';
    r.onstart = function () { handlers.onStart && handlers.onStart(); };
    r.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) { finalText += t; } else { interim += t; }
      }
      if (interim && handlers.onInterim) { handlers.onInterim(interim); }
      if (finalText && handlers.onFinal) { handlers.onFinal(finalText.trim()); }
    };
    r.onerror = function (ev) { handlers.onError && handlers.onError(ev.error || 'error'); };
    r.onend = function () { handlers.onEnd && handlers.onEnd(finalText.trim()); };
    try { r.start(); } catch (e) { handlers.onError && handlers.onError('start-failed'); }
    return {
      stop: function () { try { r.stop(); } catch (e) {} },
      abort: function () { try { r.abort(); } catch (e) {} }
    };
  };

  window.micErrorText = function (code) {
    var map = {
      unsupported: '这个浏览器不支持语音识别，请用 Chrome / Edge，或直接打字',
      'not-allowed': '麦克风被拒绝了，请在地址栏左侧允许麦克风',
      'service-not-allowed': '当前地址不允许使用麦克风，需要 HTTPS 或 localhost',
      'no-speech': '没听到声音，再说一次试试',
      'audio-capture': '没找到麦克风设备',
      network: '语音识别需要联网，检查一下网络',
      'start-failed': '麦克风启动失败，稍后再试'
    };
    return map[code] || ('语音识别出错：' + code);
  };

  /* ---------------- 偏好（只影响本机显示） ---------------- */

  window.prefs = {
    get(k, d) {
      try { var v = localStorage.getItem('anyu.pref.' + k); return v === null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('anyu.pref.' + k, JSON.stringify(v)); } catch (e) {}
    }
  };

  window.applyA11y = function () {
    document.documentElement.classList.toggle('senior', !!prefs.get('senior', false));
    document.documentElement.classList.toggle('hc', !!prefs.get('hc', false));
  };
  applyA11y();

  /* ---------------- 顶栏公共动作 ---------------- */

  window.bindTopbar = function (user) {
    var bigBtn = $('#bigBtn');
    if (bigBtn) {
      bigBtn.setAttribute('aria-pressed', prefs.get('senior', false) ? 'true' : 'false');
      bigBtn.addEventListener('click', function () {
        var on = !prefs.get('senior', false);
        prefs.set('senior', on);
        document.documentElement.classList.toggle('senior', on);
        bigBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        toast(on ? '已放大字号' : '已恢复常规字号');
      });
    }
    $$('[data-logout]').forEach(function (b) {
      b.addEventListener('click', async function () {
        try { await API.post('/api/auth/logout'); } catch (e) {}
        location.href = '/login.html';
      });
    });
    if (user && $('#whoName')) {
      $('#whoName').textContent = user.name;
      if ($('#whoRole')) {
        $('#whoRole').textContent = { elder: '老人端', family: '家属端', community: '社区端', admin: '管理' }[user.role] || '';
      }
    }
  };
  /* 注册 Service Worker：手机可添加到主屏幕，断网也能打开登录页 */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
})();
