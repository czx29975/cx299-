/* 老人端：语音对话、用药确认、血压、紧急求助、听留言 */
(function () {
  'use strict';

  var me = null;
  var overview = null;
  var thinking = false;
  var recog = null;
  var listening = false;
  var greeted = false;

  var AI_TAG = {
    llm: ['大模型对话中', 'tag-ok'],
    local: ['未接大模型，使用内置语音指令', 'tag-warn'],
    'local-fallback': ['大模型暂时不可用，已切到内置指令', 'tag-warn']
  };

  /* ---------- 渲染 ---------- */

  function greetWord() {
    var h = new Date().getHours();
    if (h < 5) { return '夜深了'; }
    if (h < 11) { return '早上好'; }
    if (h < 13) { return '中午好'; }
    if (h < 18) { return '下午好'; }
    return '晚上好';
  }

  function tickClock() {
    var n = new Date();
    var wd = '日一二三四五六'[n.getDay()];
    $('#clockLine').textContent = pad(n.getHours()) + ':' + pad(n.getMinutes());
    $('#dateLine').textContent = (n.getMonth() + 1) + ' 月 ' + n.getDate() + ' 日 · 星期' + wd;
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  function renderMeds() {
    var list = overview.meds || [];
    var box = $('#medList');
    $('#medProgress').textContent = overview.med_progress.taken + ' / ' + overview.med_progress.total;
    if (!list.length) {
      box.innerHTML = '<p class="muted small">还没有登记用药。让家属在后台加一下。</p>';
      return;
    }
    box.innerHTML = list.map(function (m) {
      var state = { taken: '已吃', due: '该吃了', late: '还没吃', upcoming: '还没到点' }[m.state];
      var cls = m.state === 'taken' ? 'taken' : (m.state === 'due' || m.state === 'late') ? 'due' : '';
      var tag = m.state === 'taken' ? 'tag-ok' : (m.state === 'due' || m.state === 'late') ? 'tag-warn' : '';
      return '<div class="med-row ' + cls + '">' +
        '<div class="med-main"><b>' + esc(m.name) + '</b>' +
          '<small>' + esc(m.time) + ' · ' + esc(m.dose || '') + ' ' + esc(m.meal || '') + '</small></div>' +
        (m.state === 'taken'
          ? '<span class="tag ' + tag + '">' + esc(m.taken_at ? hhmm(m.taken_at) + ' 已吃' : '已吃') + '</span>'
          : '<button class="btn btn-primary btn-sm" data-med="' + m.id + '">吃了</button>') +
      '</div>';
    }).join('');
  }

  function renderMessages() {
    var items = overview.messages || [];
    var box = $('#msgList');
    if (!items.length) {
      box.innerHTML = '<p class="muted small">还没有留言。</p>';
      return;
    }
    box.innerHTML = items.map(function (m) {
      return '<div class="msg-item">' + esc(m.text) +
        '<small>' + esc(m.from_name || '家人') + ' · ' + relTime(m.created_at) + '</small></div>';
    }).join('');
  }

  function renderVital() {
    var v = overview.vital;
    $('#vitalLast').textContent = v
      ? '上次：' + v.sys + ' / ' + v.dia + (v.pulse ? '，脉搏 ' + v.pulse : '') + '（' + relTime(v.measured_at) + '）'
      : '还没有记录。';
  }

  function renderContact() {
    var c = (overview && overview.contact) || {};
    var card = $('#callCard');
    if (!card) { return; }
    if (!c.phone) { card.hidden = true; return; }
    card.hidden = false;
    $('#callName').textContent = c.name || '家人';
    $('#callRelation').textContent = c.relation || '家属';
    var a = $('#callBtn');
    a.href = 'tel:' + c.phone;
    a.onclick = function () {
      if (!/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        toast('号码 ' + c.phone + '，用手机打开可直接拨打');
      }
    };
  }

  function renderTrend() {
    var box = $('#vitalTrend');
    if (!box) { return; }
    var data = (overview && overview.vitals) || [];
    if (data.length < 2) { box.innerHTML = ''; return; }
    var W = 300, H = 72, pad = 6;
    var vals = data.slice(-7);
    var max = Math.max.apply(null, vals.map(function (v) { return v.sys; })) + 6;
    var min = Math.min.apply(null, vals.map(function (v) { return v.dia; })) - 6;
    function x(i) { return pad + i * (W - pad * 2) / (vals.length - 1); }
    function y(v) { return pad + (max - v) / (max - min) * (H - pad * 2); }
    function line(key) {
      return vals.map(function (v, i) {
        return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v[key]).toFixed(1);
      }).join(' ');
    }
    box.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" role="img" aria-label="最近血压趋势">' +
        '<path d="' + line('sys') + '" fill="none" stroke="#A6362B" stroke-width="2"/>' +
        '<path d="' + line('dia') + '" fill="none" stroke="#2C6653" stroke-width="2"/>' +
        vals.map(function (v, i) {
          return '<circle cx="' + x(i) + '" cy="' + y(v.sys) + '" r="2.5" fill="#A6362B"/>' +
                 '<circle cx="' + x(i) + '" cy="' + y(v.dia) + '" r="2.5" fill="#2C6653"/>';
        }).join('') +
      '</svg>' +
      '<p class="small muted" style="margin-top:.2rem">最近 ' + vals.length + ' 次：高压最高 ' +
        Math.max.apply(null, vals.map(function (v) { return v.sys; })) + '，低压最低 ' +
        Math.min.apply(null, vals.map(function (v) { return v.dia; })) + '</p>';
  }

  function appendCallAction(contact) {
    var log = $('#chatLog');
    var last = log.querySelector('.bubble.ai:last-child');
    if (!last) { return; }
    var wrap = document.createElement('a');
    wrap.className = 'btn btn-primary btn-sm';
    wrap.style.cssText = 'margin-top:.4rem;text-decoration:none;display:inline-flex';
    wrap.href = 'tel:' + contact.phone;
    wrap.textContent = '拨打 ' + (contact.name || '家人');
    last.appendChild(document.createElement('br'));
    last.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
  }

  function bubble(text, who) {
    var el = document.createElement('div');
    el.className = 'bubble ' + who;
    var n = new Date();
    el.innerHTML = esc(text) + '<time>' + pad(n.getHours()) + ':' + pad(n.getMinutes()) + '</time>';
    var log = $('#chatLog');
    var empty = log.querySelector('.muted');
    if (empty) { empty.remove(); }
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function setAiTag(mode) {
    var cfg = AI_TAG[mode] || AI_TAG.local;
    var el = $('#aiTag');
    el.textContent = cfg[0];
    el.className = 'tag ' + cfg[1];
    el.hidden = false;
  }

  /* ---------- 数据 ---------- */

  async function loadOverview(silent) {
    try {
      overview = await API.get('/api/elder/overview');
      renderMeds();
      renderMessages();
      renderVital();
      renderContact();
      renderTrend();
      if (!greeted) {
        greeted = true;
        var e = overview.elder;
        $('#whoName').textContent = me ? me.name : e.display;
        $('#greetLine').textContent = e.display + '，' + greetWord();
        var pend = (overview.meds || []).filter(function (m) { return m.state === 'due' || m.state === 'late'; });
        var hello = e.display + '，' + greetWord() + '。';
        if (pend.length) {
          hello += '今天 ' + pend[pend.length - 1].time + ' 的' + pend[pend.length - 1].name + '还没确认，吃完跟我说一声。';
        } else if (overview.vital) {
          hello += '上次血压 ' + overview.vital.sys + ' 比 ' + overview.vital.dia + '，还稳当。';
        } else {
          hello += '有事就跟我说一声，我在。';
        }
        bubble(hello, 'ai');
        speak(hello);
      }
    } catch (err) {
      if (!silent) { toast(err.message, 'err'); }
    }
  }

  async function refreshQuiet() {
    try {
      overview = await API.get('/api/elder/overview', { silent: true });
      renderMeds();
      renderMessages();
      renderVital();
      renderContact();
      renderTrend();
    } catch (e) { /* 轮询失败不打扰老人 */ }
  }

  /* ---------- 对话 ---------- */

  async function send(text) {
    text = (text || '').trim();
    if (!text || thinking) { return; }
    thinking = true;
    bubble(text, 'me');
    $('#live').textContent = '我在听…';
    try {
      var r = await API.post('/api/chat', { text: text });
      bubble(r.reply, 'ai');
      setAiTag(r.ai_mode);
      speak(r.reply);
      $('#live').textContent = '';
      if (r.action && r.action.kind === 'call_family') {
        var c = r.action.contact || {};
        if (c.phone) { appendCallAction(c); }
      }
      if (r.action && r.action.kind === 'report_symptom' && r.action.ok) {
        toast('已经告诉' + (r.action.notified || '家人') + '了，他们会回电话',
              r.action.level === 'sos' ? 'err' : 'ok');
        refreshQuiet();
      }
      if (r.flash === 'sos') {
        toast('已经通知家人和社区', 'err');
      }
      if (r.flash === 'med' || r.flash === 'vital') {
        refreshQuiet();
      }
      if (r.ai_mode !== 'llm') {
        $('#talkHint').textContent = '内置指令模式：说"我吃过了""血压 135 85""打给女儿"';
      }
    } catch (err) {
      $('#live').textContent = '';
      toast(err.message || '没听清，再说一次', 'err');
    } finally {
      thinking = false;
    }
  }

  $('#sayForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#sayInput').value;
    $('#sayInput').value = '';
    send(v);
  });

  /* ---------- 语音 ---------- */

  function setListening(on, hint) {
    listening = on;
    $('#talkBtn').classList.toggle('listening', on);
    $('#talkBtn').setAttribute('aria-label', on ? '正在听，点一下停止' : '点一下开始说话');
    $('#talkBtn').querySelector('svg use').setAttribute('href', on ? '#i-mic' : '#i-mic');
    $('#live').textContent = hint || (on ? '我在听，您说…' : '');
    $('#talkHint').textContent = on ? '说完松手也可以，我等您' : '点一下，跟我说话';
  }

  function startVoice() {
    if (listening) {
      if (recog) { recog.stop(); }
      return;
    }
    if (!voiceSupported()) {
      toast('这个浏览器不支持语音，直接打字也一样', 'err');
      $('#sayInput').focus();
      return;
    }
    stopSpeak();
    recog = listen({
      onStart: function () { setListening(true); },
      onInterim: function (t) { $('#live').textContent = t; },
      onFinal: function (t) { setListening(false); if (t) { send(t); } },
      onError: function (code) {
        setListening(false);
        $('#live').textContent = '';
        toast(micErrorText(code), 'err');
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          $('#sayInput').focus();
        }
      },
      onEnd: function () {
        if (listening) { setListening(false); }
      }
    });
  }

  $('#talkBtn').addEventListener('click', startVoice);

  /* ---------- 用药 ---------- */

  $('#medList').addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-med]');
    if (!btn) { return; }
    btn.disabled = true;
    try {
      var r = await API.post('/api/meds/' + btn.dataset.med + '/confirm');
      toast('记上了，家人能看到', 'ok');
      overview.med_progress = r.progress;
      refreshQuiet();
      speak('好，记上了。');
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  /* ---------- 血压 ---------- */

  $('#vitalForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var sys = $('#vSys').value.trim();
    var dia = $('#vDia').value.trim();
    var pulse = $('#vPulse').value.trim();
    if (!sys || !dia) { toast('高压和低压都要填', 'err'); return; }
    try {
      await API.post('/api/vitals', { sys: Number(sys), dia: Number(dia), pulse: pulse ? Number(pulse) : null });
      toast('血压记下了', 'ok');
      $('#vSys').value = ''; $('#vDia').value = ''; $('#vPulse').value = '';
      refreshQuiet();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  /* ---------- 紧急求助 ---------- */

  function startSOS() {
    var left = 3;
    var back = document.createElement('div');
    back.className = 'backdrop';
    back.innerHTML =
      '<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="sosTitle">' +
        '<h2 id="sosTitle">正在准备求助</h2>' +
        '<div class="modal-body">' +
          '<p>倒计时结束后，会立刻通知家人和社区值班。</p>' +
          '<p style="font-size:2.6rem;font-weight:700;text-align:center;color:var(--danger);margin:.6rem 0" id="cd">3</p>' +
          '<p class="small muted">按错了就点下面的取消，不会通知任何人。</p>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn btn-ghost btn-lg" id="cancelSos" type="button">取消</button></div>' +
      '</div>';
    document.body.appendChild(back);
    var timer = setInterval(function () {
      left -= 1;
      var cd = back.querySelector('#cd');
      if (cd) { cd.textContent = String(Math.max(left, 0)); }
      if (left <= 0) {
        clearInterval(timer);
        back.remove();
        fireSOS();
      }
    }, 1000);
    back.querySelector('#cancelSos').addEventListener('click', function () {
      clearInterval(timer);
      back.remove();
      toast('已取消，没有通知任何人');
    });
  }

  async function fireSOS(reason) {
    reason = reason || '老人按下求助按钮';
    try {
      var r = await API.post('/api/sos', { reason: reason });
      speak('别着急，我这就叫人。您先坐着别动。');
      var back = document.createElement('div');
      back.className = 'backdrop';
      back.innerHTML =
        '<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="okTitle">' +
          '<h2 id="okTitle">已经在叫人了</h2>' +
          '<div class="modal-body">' +
            '<p>家人和社区值班都收到了。编号 <b>#' + r.alert_id + '</b>。</p>' +
            '<p class="small muted">如果 60 秒内没人接单，系统会自动升级提醒；3 分钟未到场会建议转 120。</p>' +
            '<p class="small muted">这个页面会一直显示，等他们联系您。</p>' +
          '</div>' +
          '<div class="modal-actions"><button class="btn btn-primary btn-lg" type="button" id="okClose">我知道了</button></div>' +
        '</div>';
      document.body.appendChild(back);
      back.querySelector('#okClose').addEventListener('click', function () { back.remove(); });
    } catch (err) {
      toast(err.message || '求助发送失败，请直接打电话给家人', 'err');
    }
  }

  $('#sosBtn').addEventListener('click', startSOS);

  /* ---------- 留言朗读 ---------- */

  $('#speakMsg').addEventListener('click', async function () {
    var items = overview.messages || [];
    if (!items.length) { toast('还没有留言'); return; }
    var text = items.slice(0, 3).map(function (m) {
      return (m.from_name || '家人') + '说：' + m.text;
    }).join('。');
    speak(text);
    try { await API.post('/api/messages/read'); } catch (e) {}
    toast('正在读给您听');
  });

  /* ---------- 守护聆听：不用按键也能报警 ---------- */

  // 听到这些词，直接进入求助倒计时（5 秒可取消）
  var GUARD_HIGH = /救命|救救我|快来人|来人啊|帮帮我|扶我|摔(倒|了|下)|跌倒|起不来|爬不起来|动不了|胸口(疼|闷|痛)|心口疼|喘不上气|喘不过气|呼吸困难|憋得慌|吐血|出血了|晕倒|叫救护车|打\s?120/;
  // 这些词先问一句，20 秒没回应才报警，避免误报
  var GUARD_SOFT = /不舒服|难受|头晕|心慌|恶心|没力气|站不稳|腿软|身上疼/;

  var guardOn = false;
  var guardRecog = null;
  var sosAt = 0;

  function guardUI() {
    var b = $('#guardBtn');
    b.textContent = '守护聆听：' + (guardOn ? '开' : '关');
    b.setAttribute('aria-pressed', guardOn ? 'true' : 'false');
    $('#guardPill').hidden = !guardOn;
    prefs.set('guard', guardOn);
  }

  function startGuard(silent) {
    if (!voiceSupported()) {
      if (!silent) { toast('这个浏览器不支持语音识别，请用 Chrome / Edge，或直接对手机说话', 'err'); }
      return false;
    }
    if (guardOn) { return true; }
    guardOn = true;
    guardUI();
    loopGuard();
    API.post('/api/elder/watch', { enabled: true }, { silent: true }).catch(function () {});
    if (!silent) {
      toast('守护已开启：喊「救命」「摔倒了」会自动报警', 'ok');
      speak('好，我听着呢。您喊救命，我就叫人。');
    }
    return true;
  }

  function stopGuard() {
    guardOn = false;
    guardUI();
    if (guardRecog) { try { guardRecog.abort(); } catch (e) {} guardRecog = null; }
    API.post('/api/elder/watch', { enabled: false }, { silent: true }).catch(function () {});
    toast('守护已关闭');
  }

  function loopGuard() {
    if (!guardOn) { return; }
    guardRecog = listen({
      continuous: true,
      onFinal: function (text) { guardCheck(text, false); },
      onInterim: function (text) { guardCheck(text, true); },
      onError: function (code) {
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          guardOn = false; guardUI();
          toast('麦克风被拒绝了，守护已关闭', 'err');
        }
      },
      onEnd: function () { if (guardOn) { setTimeout(loopGuard, 800); } }
    });
  }

  function guardCheck(text, interim) {
    if (!guardOn || !text) { return; }
    if (Date.now() - sosAt < 60000) { return; }   // 一分钟内不重复报
    if (GUARD_HIGH.test(text)) {
      guardAlarm(text.slice(0, 14), 5);
      return;
    }
    if (!interim && GUARD_SOFT.test(text)) {
      guardAsk(text.slice(0, 14));
    }
  }

  function guardAlarm(reason, secs) {
    sosAt = Date.now();
    var left = secs;
    speak('我这就叫人，您别动。');
    var back = document.createElement('div');
    back.className = 'backdrop';
    back.innerHTML =
      '<div class="modal" role="alertdialog" aria-modal="true">' +
        '<h2>正在帮您叫人</h2>' +
        '<div class="modal-body">' +
          '<p>听到「' + esc(reason) + '」，' + left + ' 秒后通知家人和社区。</p>' +
          '<p style="font-size:2.6rem;font-weight:700;text-align:center;color:var(--danger);margin:.5rem 0" id="gcd">' + left + '</p>' +
          '<p class="small muted">您还好就点下面取消，不会通知任何人。</p>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn btn-ghost btn-lg" id="gcancel" type="button">我没事，取消</button></div>' +
      '</div>';
    document.body.appendChild(back);
    var timer = setInterval(function () {
      left -= 1;
      var el = back.querySelector('#gcd');
      if (el) { el.textContent = String(Math.max(left, 0)); }
      if (left <= 0) {
        clearInterval(timer);
        back.remove();
        fireSOS('语音呼救：' + reason);
      }
    }, 1000);
    back.querySelector('#gcancel').addEventListener('click', function () {
      clearInterval(timer);
      back.remove();
      sosAt = 0;
      toast('已取消，没有通知任何人');
    });
  }

  function guardAsk(text) {
    sosAt = Date.now();
    var left = 20;
    speak('您是不是不舒服？要我叫人来吗？');
    var back = document.createElement('div');
    back.className = 'backdrop';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<h2>您还好吗？</h2>' +
        '<div class="modal-body">' +
          '<p>听到您说「' + esc(text) + '」。需要我叫家人吗？</p>' +
          '<p class="small muted"><b id="gleft">' + left + '</b> 秒内没有回应，我就直接叫人了。</p>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-lg" id="gok" type="button">我没事</button>' +
          '<button class="btn btn-primary btn-lg" id="gyes" type="button">叫人来</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);
    var done = false;
    var timer = setInterval(function () {
      left -= 1;
      var el = back.querySelector('#gleft');
      if (el) { el.textContent = String(Math.max(left, 0)); }
      if (left <= 0 && !done) { finish(true); }
    }, 1000);
    function finish(call) {
      if (done) { return; }
      done = true;
      clearInterval(timer);
      back.remove();
      if (call) { fireSOS('语音求助：' + text); }
      else { sosAt = 0; toast('好，那我陪着您'); }
    }
    back.querySelector('#gok').addEventListener('click', function () { finish(false); });
    back.querySelector('#gyes').addEventListener('click', function () { finish(true); });
  }

  $('#guardBtn').addEventListener('click', function () {
    if (guardOn) { stopGuard(); } else { startGuard(false); }
  });

  /* ---------- 设备心跳：用来看"设备还活着吗" ---------- */

  function heartbeat() {
    if (document.hidden) { return; }
    API.post('/api/elder/heartbeat', { path: location.pathname }, { silent: true })
      .catch(function () {});
  }

  /* ---------- 启动 ---------- */

  (async function init() {
    applyA11y();
    tickClock();
    setInterval(tickClock, 20000);
    try {
      var r = await API.get('/api/me');
      me = r.user;
      bindTopbar(me);
    } catch (e) { return; }
    await loadOverview();
    setInterval(refreshQuiet, 12000);

    heartbeat();
    setInterval(heartbeat, 60000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { heartbeat(); }
    });

    // 上次开着守护的，进页面自动恢复（浏览器需要一次用户手势才能稳定开麦）
    if (prefs.get('guard', false) && voiceSupported()) {
      setTimeout(function () {
        if (startGuard(true)) { toast('守护聆听已恢复'); }
      }, 1200);
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { refreshQuiet(); }
    });
  })();
})();
