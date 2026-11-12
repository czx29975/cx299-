/* =========================================================
   安语 · 可用原型
   老人端：语音/文字对话、服药确认、血压记录、亲情通话、SOS
   家属端：告警、周报、用药、留言、授权
   所有数据仅存本机 localStorage；通话与应急为模拟流程
   ========================================================= */
(function () {
  'use strict';

  var KEY = 'anyu.app.v1';
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var timeStr = function (d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  var dateKey = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var now = function () { return new Date(); };
  var uid = function (p) { return p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); };

  var state;
  var view = 'home';
  var listening = false;
  var recog = null;
  var pendingVital = null;
  var lastSymptom = '';
  var modalLocked = false;
  var lastFocus = null;
  var sos = null;
  var call = null;
  var toastTimer = null;

  /* ---------------- 数据 ---------------- */

  function seed() {
    var n = now();
    var dueToday = function (h, m) {
      var d = new Date(n);
      d.setHours(h, m, 0, 0);
      return d;
    };
    var takenIf = function (h, m, offset) {
      var due = dueToday(h, m);
      if (n.getTime() - due.getTime() >= 10 * 60000) {
        return timeStr(new Date(due.getTime() + offset * 60000));
      }
      return null;
    };

    var meds = [
      {
        id: 'med-1', name: '苯磺酸氨氯地平片', short: '降压药', dose: '1 片',
        time: '08:00', meal: '早饭后', takenAt: takenIf(8, 0, 7)
      },
      {
        id: 'med-2', name: '二甲双胍缓释片', short: '降糖药', dose: '1 片',
        time: '12:30', meal: '随餐', takenAt: takenIf(12, 30, 6)
      },
      {
        id: 'med-3', name: '苯磺酸氨氯地平片', short: '降压药', dose: '1 片',
        time: '18:30', meal: '晚饭后', takenAt: null
      }
    ];

    var samples = [
      [148, 92, 78], [142, 88, 76], [139, 86, 75], [136, 84, 74],
      [138, 86, 76], [134, 82, 72], [135, 85, 74]
    ];
    var vitals = samples.map(function (s, i) {
      var d = new Date(n);
      d.setDate(d.getDate() - (6 - i));
      return {
        date: dateKey(d), time: i === 6 ? '08:12' : '07:5' + (i + 1),
        s: s[0], d: s[1], p: s[2]
      };
    });

    return {
      v: 1,
      profile: {
        name: '王秀兰',
        display: '王阿姨',
        age: 78,
        address: '西安市碑林区建设路 12 号 3 单元 402',
        bloodType: 'A 型',
        conditions: '高血压、2 型糖尿病',
        allergies: '青霉素',
        medsText: '苯磺酸氨氯地平片、二甲双胍缓释片',
        contact: { name: '李梅', relation: '女儿', phone: '138****6621' },
        community: '社区值班 029-8***110'
      },
      meds: meds,
      vitals: vitals,
      weekly: {
        total: 21,
        taken: 18 + meds.filter(function (m) { return m.takenAt; }).length,
        calls: 4,
        nights: 2
      },
      alerts: [
        {
          id: 'alert-seed-1', level: 'info', title: '夜间离床 2 次',
          detail: '02:10 与 03:40，均在正常范围，无需处理。',
          time: '今天 02:10', status: '已归档'
        },
        {
          id: 'alert-seed-2', level: 'warn', title: '设备曾离线 5 分钟',
          detail: '昨天 15:20 自动重连，心跳已恢复。',
          time: '昨天 15:20', status: '已恢复'
        }
      ],
      messages: [
        {
          id: 'msg-seed-1', from: '李梅', role: 'daughter',
          text: '妈，周六上午十点我来看您，记得把降压药放桌上。',
          time: '今天 09:12'
        }
      ],
      readMsgId: '',
      consent: { shareHealth: true, radar: true, location: false },
      settings: { senior: false, contrast: false, voice: true, rate: 0.85 },
      moods: ['腿疼 ×2', '睡得浅 ×1'],
      convo: []
    };
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && data.v === 1 && Array.isArray(data.meds)) { return data; }
      }
    } catch (e) { /* ignore */ }
    return seed();
  }

  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  /* ---------------- 工具 ---------------- */

  function greetWord() {
    var h = now().getHours();
    if (h < 5) { return '夜深了'; }
    if (h < 9) { return '早上好'; }
    if (h < 12) { return '上午好'; }
    if (h < 14) { return '中午好'; }
    if (h < 18) { return '下午好'; }
    if (h < 23) { return '晚上好'; }
    return '夜深了';
  }

  function medDue(time) {
    var d = now();
    var p = String(time).split(':');
    d.setHours(Number(p[0]), Number(p[1]), 0, 0);
    return d;
  }

  function medStatus(m) {
    if (m.takenAt) { return { key: 'taken', label: '已确认 ' + m.takenAt }; }
    var due = medDue(m.time);
    if (now() < due) { return { key: 'upcoming', label: '未到时间' }; }
    var mins = Math.max(0, Math.round((now() - due) / 60000));
    if (mins < 1) { return { key: 'pending', label: '到点了' }; }
    if (mins < 60) { return { key: 'pending', label: '待确认 · 已过 ' + mins + ' 分钟' }; }
    return { key: 'pending', label: '待确认 · 已过 ' + Math.floor(mins / 60) + ' 小时' };
  }

  function takenCount() { return state.meds.filter(function (m) { return m.takenAt; }).length; }

  function nextPending() {
    var due = state.meds.filter(function (m) { return !m.takenAt && now() >= medDue(m.time); });
    if (due.length) { return due[0]; }
    return state.meds.filter(function (m) { return !m.takenAt; })[0] || null;
  }

  function lastDaughterMsg() {
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'daughter') { return state.messages[i]; }
    }
    return null;
  }

  function activeAlerts() {
    return state.alerts.filter(function (a) { return a.status === '处理中' || a.status === '待处理'; });
  }

  function toast(text) {
    var wrap = $('#toastWrap');
    if (!wrap) { return; }
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    wrap.appendChild(el);
    window.setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s ease';
      window.setTimeout(function () { el.remove(); }, 320);
    }, 2400);
  }

  /* ---------------- 语音 ---------------- */

  var synth = ('speechSynthesis' in window) ? window.speechSynthesis : null;
  var voice = null;
  if (synth) {
    var pickVoice = function () {
      if (voice) { return voice; }
      var voices = [];
      try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
      for (var i = 0; i < voices.length; i++) {
        if (/zh[-_]?CN|zh[-_]?Hans|Chinese|中文|普通话/i.test(voices[i].lang + ' ' + voices[i].name)) {
          voice = voices[i];
          break;
        }
      }
      return voice;
    };
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', function () { voice = null; pickVoice(); });
    }
    pickVoice();
  }

  function speak(text) {
    if (!state.settings.voice || !synth || !text) { return; }
    try {
      synth.cancel();
      var u = new window.SpeechSynthesisUtterance(String(text));
      u.lang = 'zh-CN';
      u.rate = Number(state.settings.rate) || 0.85;
      u.pitch = 1;
      var v = pickVoice();
      if (v) { u.voice = v; }
      synth.speak(u);
    } catch (e) { /* ignore */ }
  }

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  function setVoiceUI(mode, text) {
    var orb = $('#talkBtn');
    var hint = $('#voiceHint');
    var live = $('#liveText');
    orb.classList.toggle('is-listening', mode === 'listening');
    if (mode === 'listening') {
      hint.textContent = '我在听，您说';
      live.className = 'live-text';
      live.textContent = text || '……';
    } else if (mode === 'error') {
      hint.textContent = '点一下，跟我说话';
      live.className = 'live-text is-error';
      live.textContent = text || '';
    } else {
      hint.textContent = '点一下，跟我说话';
      live.className = 'live-text';
      live.textContent = text || '';
    }
  }

  function stopListening() {
    listening = false;
    if (recog) {
      try { recog.stop(); } catch (e) { /* ignore */ }
    }
    setVoiceUI('idle', '');
  }

  function startListening() {
    if (!SR) {
      setVoiceUI('error', '这个浏览器不支持语音识别，请用下面的文字输入（推荐 Chrome 或 Edge）。');
      $('#sayInput').focus();
      return;
    }
    if (listening) { stopListening(); return; }
    try {
      if (!recog) {
        recog = new SR();
        recog.lang = 'zh-CN';
        recog.interimResults = true;
        recog.maxAlternatives = 1;
        recog.continuous = false;

        recog.onstart = function () {
          listening = true;
          setVoiceUI('listening', '');
        };
        recog.onresult = function (event) {
          var interim = '';
          var finalText = '';
          for (var i = event.resultIndex; i < event.results.length; i++) {
            var chunk = event.results[i][0].transcript;
            if (event.results[i].isFinal) { finalText += chunk; }
            else { interim += chunk; }
          }
          setVoiceUI('listening', interim || finalText || '……');
          if (finalText.trim()) {
            listening = false;
            try { recog.stop(); } catch (e) { /* ignore */ }
            setVoiceUI('idle', '');
            handleText(finalText.trim());
          }
        };
        recog.onerror = function (event) {
          listening = false;
          var map = {
            'not-allowed': '没有拿到麦克风权限。请允许麦克风后再试，或者直接打字。',
            'service-not-allowed': '浏览器不允许使用语音识别，请用文字输入。',
            'no-speech': '我没听清，再说一次？',
            'audio-capture': '找不到麦克风，请检查设备。',
            'network': '语音识别服务连不上（直接打开文件时常见）。可以改用文字输入，或用本地服务器打开。'
          };
          setVoiceUI('error', map[event.error] || '语音出了点问题，先用文字告诉我吧。');
        };
        recog.onend = function () {
          listening = false;
          var orb = $('#talkBtn');
          if (orb.classList.contains('is-listening')) {
            orb.classList.remove('is-listening');
            $('#voiceHint').textContent = '点一下，跟我说话';
          }
        };
      }
      setVoiceUI('listening', '');
      recog.start();
    } catch (e) {
      listening = false;
      setVoiceUI('error', '麦克风没有启动成功，请用文字输入。');
    }
  }

  /* ---------------- 对话 ---------------- */

  function seedGreeting() {
    var p = nextPending();
    var text = p
      ? state.profile.display + '，' + greetWord() + '。今天 ' + p.time + ' 的' + p.short + '还没确认，吃完跟我说一声“吃过了”。'
      : state.profile.display + '，' + greetWord() + '。今天的事都记好了，有事您叫我。';
    state.convo = [{ role: 'ai', text: text, time: timeStr(now()), kind: 'text' }];
  }

  function addMsg(role, text, opts) {
    opts = opts || {};
    state.convo.push({
      role: role,
      text: text,
      time: timeStr(now()),
      kind: opts.kind || 'text',
      actions: opts.actions || null
    });
    if (state.convo.length > 30) { state.convo = state.convo.slice(-30); }
    save();
    renderConvo();
    if (role === 'ai' && opts.speak !== false) { speak(text); }
  }

  function addAi(text, actions, opts) {
    var o = opts || {};
    o.actions = actions && actions.length ? actions : null;
    addMsg('ai', text, o);
  }

  function handleText(text) {
    var raw = String(text || '').trim();
    if (!raw) { return; }
    if (listening) { stopListening(); }
    setVoiceUI('idle', '');
    addMsg('user', raw);
    handleIntent(raw);
  }

  function handleIntent(raw) {
    var t = raw.replace(/[\s，。！？、,.!?~～]/g, '');

    if (pendingVital) {
      if (/^(对|是|嗯|好|对的|是的|没错|记上|对的呀)/.test(t)) {
        saveVital(pendingVital.s, pendingVital.d, pendingVital.p);
        pendingVital = null;
        return;
      }
      if (/^(不对|不是|错了|重新|错的)/.test(t)) {
        pendingVital = null;
        addAi('好，那这次不记。您再说一次，比如“血压 135 85”。');
        return;
      }
      pendingVital = null;
    }

    if (/救命|救救我|摔(倒|了)|起不来|快来人/.test(t)) {
      addAi('别着急，我这就叫人。您先别起身。');
      window.setTimeout(function () { startSOS('voice'); }, 500);
      return;
    }

    if (/验证码|转账|汇款|中奖|安全账户|公检法|银行卡|密码/.test(t)) {
      addAi('涉及验证码和转账的电话，先别念、也别转钱。要不要我直接拨给李女士，让她本人跟您核一下？', [
        { label: '打给李女士', act: 'call' },
        { label: '我不理它了', act: 'dismiss' }
      ]);
      return;
    }

    var vital = parseVital(raw);
    if (vital) {
      pendingVital = vital;
      addAi('我记一下：高压 ' + vital.s + '，低压 ' + vital.d + '，对吗？', [
        { label: '对，记上', act: 'vital-yes' },
        { label: '不对，重说', act: 'vital-no' }
      ]);
      return;
    }

    if (/吃(过|了|药)|服药|用药|该吃|什么药|还有.+药/.test(t)) {
      var p = nextPending();
      if (/吃(过|了)/.test(t) && !/什么|哪/.test(t)) {
        if (p) { confirmMed(p.id); }
        else { addAi('今天的药都已经记上了，不用再吃了。'); }
      } else if (p) {
        addAi('今天还有 ' + p.time + ' 的' + p.short + '（' + p.dose + '）没确认。吃完了跟我说“我吃过了”。', [
          { label: '我吃过了', act: 'med', arg: p.id }
        ]);
      } else {
        addAi('今天的药都记上了。药盒在餐桌左边第二个格子，需要我再说一遍用药时间吗？');
      }
      return;
    }

    if (/打给|打电话|视频|闺女|女儿|儿子|老伴|家人/.test(t)) {
      addAi('好，我这就给李女士打视频。');
      window.setTimeout(startCall, 600);
      return;
    }

    if (/胸痛|胸口|胸闷|喘不上气|呼吸困难|说不出话|嘴歪|半边|一侧|晕倒|抽搐|意识/.test(t)) {
      lastSymptom = raw;
      addAi('您说的这个情况要紧。我先帮您叫人，别着急，也别自己起身。');
      window.setTimeout(function () { startSOS('symptom'); }, 600);
      return;
    }

    if (/头晕|头疼|头痛|心慌|不舒服|难受|没力气|恶心|疼|麻/.test(t)) {
      lastSymptom = raw;
      var tag = raw.length > 12 ? raw.slice(0, 12) + '…' : raw;
      if (state.moods.indexOf(tag) === -1) { state.moods.unshift(tag); }
      state.moods = state.moods.slice(0, 5);
      save();
      addAi('这个我不能替您判断，也不建议自己改药量。我先记下来。要不要我通知李女士，或者接通人工健康坐席？', [
        { label: '通知李女士', act: 'notify' },
        { label: '接通健康坐席', act: 'seat' },
        { label: '我先歇会儿', act: 'dismiss' }
      ]);
      return;
    }

    if (/几点|时间/.test(t) && t.length <= 8) {
      addAi('现在是 ' + timeStr(now()) + '。');
      return;
    }

    if (/几号|日期|星期|周几/.test(t)) {
      var d = now();
      addAi('今天是 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日，' + WEEK[d.getDay()] + '。');
      return;
    }

    if (/天气|下雨|气温|冷|热/.test(t)) {
      addAi('今天晴，18 度，早晚有点凉，出门记得加件外套。天气是示例数据。');
      return;
    }

    if (/戏曲|京剧|豫剧|评书|歌|音乐|听点/.test(t)) {
      addAi('好，给您放一段豫剧《花木兰》选段。声音大了小了，跟我说。', null, { kind: 'music' });
      return;
    }

    if (/想你|孤单|寂寞|睡不着|无聊|害怕|没意思|聊聊|说话/.test(t)) {
      addAi('我在呢。您想说说以前的事，还是我帮您给李女士打个电话？', [
        { label: '打给李女士', act: 'call' },
        { label: '陪我说说话', act: 'chat' }
      ]);
      return;
    }

    if (/你会什么|能做什么|怎么用|帮帮我/.test(t)) {
      addAi('您可以跟我说：我吃过了、打给女儿、今天几号、我有点头晕、血压 135 85。也可以点下面的按钮。', [
        { label: '看使用说明', act: 'help' }
      ]);
      return;
    }

    if (/^(好|好的|行|知道了|谢谢|谢谢你|晓得了|嗯)+$/.test(t)) {
      addAi('不客气，有事您叫我。');
      return;
    }

    addAi('这句我还没学会。您可以说“我吃过了”“打给女儿”“我有点头晕”，或者点下面的按钮。', [
      { label: '使用说明', act: 'help' }
    ]);
  }

  function parseVital(text) {
    var m = text.match(/(\d{2,3})\s*(?:\/|,|，|、|和|\s)\s*(\d{2,3})/);
    if (!m) { return null; }
    var s = Number(m[1]);
    var d = Number(m[2]);
    if (s < 70 || s > 250 || d < 40 || d > 150 || d >= s) { return null; }
    return { s: s, d: d, p: null };
  }

  function saveVital(s, d, p) {
    var n = now();
    var pulse = Number(p) || (state.vitals.length ? state.vitals[state.vitals.length - 1].p : 74);
    state.vitals.push({ date: dateKey(n), time: timeStr(n), s: s, d: d, p: pulse });
    if (state.vitals.length > 30) { state.vitals.shift(); }
    state.logs = state.logs || [];
    state.logs.push({ type: 'vital', at: n.toISOString(), s: s, d: d, p: pulse });
    save();
    renderFamily();
    addAi('好，记上了。' + s + '/' + d + '，心率 ' + pulse + '。家属端也更新了。');
    toast('血压已记录');
  }

  /* ---------------- 用药 ---------------- */

  function confirmMed(id) {
    var m = state.meds.filter(function (x) { return x.id === id; })[0];
    if (!m || m.takenAt) { return; }
    m.takenAt = timeStr(now());
    state.weekly.taken = Math.min(state.weekly.total, state.weekly.taken + 1);
    state.logs = state.logs || [];
    state.logs.push({ type: 'med', id: id, at: now().toISOString() });
    save();
    renderAll();
    var rest = state.meds.filter(function (x) { return !x.takenAt; }).length;
    addAi('好，记上了。' + m.time + ' 的' + m.short + '，' + m.takenAt + ' 已服用。' +
      (rest ? ('今天还剩 ' + rest + ' 次药。') : '今天的药都齐了，真不错。'));
    toast('已记录 ' + m.takenAt + '，家属端同步');
  }

  /* ---------------- 通知家属 / 坐席 ---------------- */

  function notifyFamily() {
    var detail = lastSymptom || '老人主诉身体不适';
    state.alerts.unshift({
      id: uid('alert'),
      level: 'warn',
      title: '老人主诉不适',
      detail: '老人说：' + detail + '。请回电确认。',
      time: '今天 ' + timeStr(now()),
      status: '待处理',
      raisedAt: now().getTime()
    });
    state.messages.push({
      id: uid('msg'),
      from: '安语',
      role: 'assistant',
      text: '李女士，' + state.profile.display + '刚才说：' + detail + '。请回电确认。',
      time: '刚刚'
    });
    save();
    renderAll();
    toast('已通知李女士');
    addAi('已经给李女士发了消息，她看到会回您。');
  }

  function seat() {
    toast('正在接通人工健康坐席…');
    window.setTimeout(function () {
      addAi('健康坐席已接通（演示）。真实产品里，症状、用药、急救、支付与法律问题都会直接转给人工。');
    }, 1000);
  }

  /* ---------------- 通话 ---------------- */

  function callModalHTML(connected) {
    if (!connected) {
      return '<div class="modal-head"><div><h2 id="modalTitle">正在呼叫</h2>' +
        '<p class="sub">模拟通话，不会真的拨号。</p></div></div>' +
        '<div class="call-box"><span class="call-avatar">李</span>' +
        '<h3>李梅（女儿）</h3><p>138****6621</p>' +
        '<div class="call-state ringing">正在呼叫…</div>' +
        '<div class="call-timer" id="callTimer">00:00</div>' +
        '<div class="call-actions"><button class="btn btn-danger" type="button" data-mact="call-hang">挂断</button></div></div>';
    }
    return '<div class="modal-head"><div><h2 id="modalTitle">通话中</h2>' +
      '<p class="sub">模拟通话，不会真的拨号。</p></div></div>' +
      '<div class="call-box"><span class="call-avatar">李</span>' +
      '<h3>李梅（女儿）</h3><p>138****6621</p>' +
      '<div class="call-state">已接通（模拟）</div>' +
      '<div class="call-timer" id="callTimer">00:00</div>' +
      '<div class="call-actions"><button class="btn btn-danger" type="button" data-mact="call-hang">挂断</button></div></div>';
  }

  function startCall() {
    call = { active: true, connectedAt: null, timer: null, connectTimer: null };
    openModal(callModalHTML(false), { locked: true });
    speak('正在呼叫李女士。');
    call.connectTimer = window.setTimeout(function () {
      if (!call || !call.active) { return; }
      call.connectedAt = Date.now();
      var body = $('#modalBody');
      if (body) { body.innerHTML = callModalHTML(true); }
      speak('接通了，您说。');
      call.timer = window.setInterval(function () {
        var el = $('#callTimer');
        if (!el || !call || !call.connectedAt) { return; }
        var s = Math.floor((Date.now() - call.connectedAt) / 1000);
        el.textContent = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
      }, 1000);
    }, 2400);
  }

  function endCall() {
    if (!call) { return; }
    call.active = false;
    if (call.timer) { window.clearInterval(call.timer); }
    if (call.connectTimer) { window.clearTimeout(call.connectTimer); }
    var seconds = call.connectedAt ? Math.max(1, Math.round((Date.now() - call.connectedAt) / 1000)) : 0;
    if (seconds > 0) { state.weekly.calls += 1; }
    state.logs = state.logs || [];
    state.logs.push({ type: 'call', at: now().toISOString(), seconds: seconds });
    call = null;
    save();
    renderFamily();
    closeModal(true);
    if (seconds > 0) {
      addAi('好，今天聊了 ' + Math.max(1, Math.round(seconds / 60)) + ' 分钟。有事再叫我。');
    } else {
      addAi('这次没接通，我记下了。要不要过一会儿再试？');
    }
  }

  /* ---------------- SOS ---------------- */

  function sosCountdownHTML() {
    return '<div class="modal-head"><div><h2 id="modalTitle">要现在求助吗？</h2>' +
      '<p class="sub">3 秒后开始呼叫家属、社区与急救。按错了可以取消。</p></div></div>' +
      '<div class="sos-count" id="sosCount">3</div>' +
      '<p style="text-align:center;font-size:.9rem;color:var(--ink-2)">我会先联系李梅（女儿），并同步应急信息卡。</p>' +
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" type="button" data-mact="sos-cancel">取消，我按错了</button>' +
      '<button class="btn btn-primary" type="button" data-mact="sos-now" style="background:var(--danger)">立即呼叫</button>' +
      '</div>' +
      '<p class="modal-note">演示：不会真的拨号或报警。真实产品中，SOS 不依赖唤醒词与网络。</p>';
  }

  function sosActiveHTML(alert) {
    return '<div class="modal-head"><div><h2 id="modalTitle">正在为您呼叫</h2>' +
      '<p class="sub">已启动三级联动。请保持通话，不要急着起身。</p></div></div>' +
      '<div class="sos-steps" id="sosSteps">' +
      '<div class="sos-step active" data-step="1"><span class="bullet"></span><div><strong>李梅（女儿）</strong><p>正在呼叫…</p></div><em>0 秒</em></div>' +
      '<div class="sos-step" data-step="2"><span class="bullet"></span><div><strong>社区值班 · 王网格员</strong><p>等待家属接听</p></div><em>60 秒</em></div>' +
      '<div class="sos-step" data-step="3"><span class="bullet"></span><div><strong>120 急救中心</strong><p>待升级</p></div><em>3 分钟</em></div>' +
      '</div>' +
      '<div class="sos-card"><h4>应急信息卡 · 已脱敏</h4><dl>' +
      '<dt>住址</dt><dd>' + esc(state.profile.address) + '</dd>' +
      '<dt>病史</dt><dd>' + esc(state.profile.conditions) + '</dd>' +
      '<dt>过敏</dt><dd>' + esc(state.profile.allergies) + '</dd>' +
      '<dt>常用药</dt><dd>' + esc(state.profile.medsText) + '</dd>' +
      '<dt>联系人</dt><dd>' + esc(state.profile.contact.name) + '（' + esc(state.profile.contact.relation) + '）' + esc(state.profile.contact.phone) + '</dd>' +
      '</dl></div>' +
      '<p class="modal-note">演示已加速：真实流程为家属 60 秒未接转社区值班，3 分钟未闭环按预案联系 120，全程留痕。</p>' +
      '<div class="modal-actions" id="sosEndActions" hidden>' +
      '<button class="btn btn-primary" type="button" data-mact="sos-end">结束演示并归档</button>' +
      '</div>';
  }

  function startSOS(source) {
    if (sos) { return; }
    closeModal(true);
    sos = { phase: 'countdown', left: 3, timer: null, timeouts: [], alertId: null };
    openModal(sosCountdownHTML(), { locked: true, cls: 'is-sos' });
    speak('别着急，我这就叫人。三秒后开始呼叫，按错了可以取消。');
    sos.timer = window.setInterval(function () {
      if (!sos) { return; }
      sos.left -= 1;
      var el = $('#sosCount');
      if (el) { el.textContent = String(Math.max(0, sos.left)); }
      if (sos.left <= 0) {
        window.clearInterval(sos.timer);
        triggerSOS();
      }
    }, 1000);
  }

  function triggerSOS() {
    if (!sos) { return; }
    sos.phase = 'active';
    var n = now();
    var alert = {
      id: uid('sos'),
      level: 'sos',
      title: '紧急求助 · 疑似跌倒/身体不适',
      detail: '老人端触发紧急求助，已启动三级联动。',
      time: '今天 ' + timeStr(n),
      status: '处理中',
      raisedAt: n.getTime()
    };
    sos.alertId = alert.id;
    state.alerts.unshift(alert);
    save();
    renderAll();
    openModal(sosActiveHTML(alert), { locked: true, cls: 'is-sos' });
    speak('已经开始呼叫李女士。您别起身，我陪着您。');

    sos.timeouts.push(window.setTimeout(function () {
      sosStep(1, 'done', '李梅（女儿）', '未接听，已转社区值班');
      sosStep(2, 'active', '社区值班 · 王网格员', '正在呼叫…');
    }, 2800));
    sos.timeouts.push(window.setTimeout(function () {
      sosStep(2, 'done', '社区值班 · 王网格员', '已接单，正在上门');
      sosStep(3, 'active', '120 急救中心', '正在推送地址与信息卡');
    }, 5600));
    sos.timeouts.push(window.setTimeout(function () {
      sosStep(3, 'done', '120 急救中心', '已受理，急救已派出');
      var actions = $('#sosEndActions');
      if (actions) { actions.hidden = false; }
      speak('已经联系上社区和急救。我在这儿陪着您。');
    }, 8400));
  }

  function sosStep(index, cls, title, note) {
    var el = document.querySelector('.sos-step[data-step="' + index + '"]');
    if (!el) { return; }
    el.classList.remove('active', 'done');
    if (cls) { el.classList.add(cls); }
    if (title) { el.querySelector('strong').textContent = title; }
    if (note) { el.querySelector('p').textContent = note; }
  }

  function cancelSOS() {
    if (!sos) { return; }
    if (sos.timer) { window.clearInterval(sos.timer); }
    sos = null;
    closeModal(true);
    addAi('好，已经取消，没有通知任何人。有不舒服随时叫我。');
  }

  function endSOS() {
    if (!sos) { return; }
    (sos.timeouts || []).forEach(function (t) { window.clearTimeout(t); });
    if (sos.timer) { window.clearInterval(sos.timer); }
    var alert = state.alerts.filter(function (a) { return a.id === sos.alertId; })[0];
    if (alert) {
      alert.status = '已闭环';
      alert.closedAt = now().getTime();
      alert.detail += ' 演示已结束并归档。';
    }
    sos = null;
    save();
    renderAll();
    closeModal(true);
    addAi('好，已经记录并归档。以后有事随时叫我。');
    toast('应急演练已归档');
  }

  /* ---------------- 弹层 ---------------- */

  function openModal(html, opts) {
    opts = opts || {};
    lastFocus = document.activeElement;
    $('#modalBody').innerHTML = html;
    var box = $('#modalBox');
    box.className = 'modal' + (opts.cls ? (' ' + opts.cls) : '');
    $('#modalBackdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    modalLocked = !!opts.locked;
    var focusable = $('#modalBody').querySelector('button, input, [href]');
    if (focusable) {
      window.setTimeout(function () { try { focusable.focus(); } catch (e) { /* ignore */ } }, 60);
    }
  }

  function closeModal(force) {
    if (modalLocked && !force) { return; }
    $('#modalBackdrop').hidden = true;
    $('#modalBody').innerHTML = '';
    document.body.style.overflow = '';
    modalLocked = false;
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) { /* ignore */ }
    }
    lastFocus = null;
  }

  function helpHTML() {
    return '<div class="modal-head"><div><h2 id="modalTitle">怎么用</h2><p class="sub">这个演示想让你用三分钟，走完老人一天里最要紧的几件事。</p></div>' +
      '<button class="modal-close" type="button" data-mact="close" aria-label="关闭">×</button></div>' +
      '<ul class="plain">' +
      '<li><b>说话。</b>点中间的大圆钮，说“我吃过了”“打给女儿”“我有点头晕”。不想说话就打字，效果一样。</li>' +
      '<li><b>确认用药。</b>右侧“今日用药”里点“确认已服用”，家属端的确认率会一起更新。</li>' +
      '<li><b>量血压。</b>说“血压 135 85”，助手会复述一遍，确认后写入趋势；也可以点家属端的“记录血压”。</li>' +
      '<li><b>紧急求助。</b>底部红按钮有 3 秒倒计时，可取消。演示会加速跑完家属 → 社区 → 120 三级联动。</li>' +
      '<li><b>换到家属端。</b>右上角切到“家属端”，能看告警、周报、留言和授权开关。</li>' +
      '</ul>' +
      '<p class="modal-note">语音识别由浏览器提供：Chrome / Edge 支持较好；直接双击打开文件时麦克风常被限制，用本地服务器（如 python -m http.server）打开最稳。没有麦克风也能全程用文字完成。</p>' +
      '<p class="modal-note">这是本地演示：数据只写进本机浏览器，不连接大模型、不真的拨号，也不替代 120。</p>' +
      '<div class="modal-actions"><button class="btn btn-primary" type="button" data-mact="close">知道了</button></div>';
  }

  function settingsHTML() {
    return '<div class="modal-head"><div><h2 id="modalTitle">设置</h2><p class="sub">显示、声音与演示数据。</p></div>' +
      '<button class="modal-close" type="button" data-mact="close" aria-label="关闭">×</button></div>' +
      '<div class="consent-list">' +
      '<label class="switch"><span>大字模式<small>正文放大，间距更松</small></span><input type="checkbox" data-setting="senior"' + (state.settings.senior ? ' checked' : '') + '><i aria-hidden="true"></i></label>' +
      '<label class="switch"><span>高对比<small>纯黑白，边框更清楚</small></span><input type="checkbox" data-setting="contrast"' + (state.settings.contrast ? ' checked' : '') + '><i aria-hidden="true"></i></label>' +
      '<label class="switch"><span>语音播报<small>助手的回复会读出来</small></span><input type="checkbox" data-setting="voice"' + (state.settings.voice ? ' checked' : '') + '><i aria-hidden="true"></i></label>' +
      '</div>' +
      '<div class="field-row"><div class="field full"><label for="rateInput">播报语速 <b id="rateVal">' + Number(state.settings.rate).toFixed(2) + '×</b></label>' +
      '<input id="rateInput" type="range" min="0.6" max="1.1" step="0.05" value="' + state.settings.rate + '"></div></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" type="button" data-mact="reset">重置演示数据</button>' +
      '<button class="btn btn-primary" type="button" data-mact="close">完成</button></div>' +
      '<p class="modal-note">数据保存在本机 localStorage，不会上传。清理浏览器数据或“重置演示数据”即可恢复初始状态。</p>';
  }

  function emergencyCardHTML() {
    return '<div class="modal-head"><div><h2 id="modalTitle">应急信息卡</h2><p class="sub">呼救时向到场者展示，仅限本次事件、脱敏使用。</p></div>' +
      '<button class="modal-close" type="button" data-mact="close" aria-label="关闭">×</button></div>' +
      '<div class="sos-card"><dl>' +
      '<dt>姓名</dt><dd>' + esc(state.profile.name) + '，' + state.profile.age + ' 岁</dd>' +
      '<dt>住址</dt><dd>' + esc(state.profile.address) + '</dd>' +
      '<dt>血型</dt><dd>' + esc(state.profile.bloodType) + '</dd>' +
      '<dt>病史</dt><dd>' + esc(state.profile.conditions) + '</dd>' +
      '<dt>过敏</dt><dd>' + esc(state.profile.allergies) + '</dd>' +
      '<dt>常用药</dt><dd>' + esc(state.profile.medsText) + '</dd>' +
      '<dt>联系人</dt><dd>' + esc(state.profile.contact.name) + '（' + esc(state.profile.contact.relation) + '）' + esc(state.profile.contact.phone) + '</dd>' +
      '<dt>社区</dt><dd>' + esc(state.profile.community) + '</dd>' +
      '</dl></div>' +
      '<p class="modal-note">信息卡需要老人预先授权；不包含身份证号、银行卡等无关信息。</p>' +
      '<div class="modal-actions"><button class="btn btn-primary" type="button" data-mact="close">关闭</button></div>';
  }

  function vitalModalHTML() {
    return '<div class="modal-head"><div><h2 id="modalTitle">记录血压</h2><p class="sub">数值只用于记录与趋势呈现，不构成诊断。</p></div>' +
      '<button class="modal-close" type="button" data-mact="close" aria-label="关闭">×</button></div>' +
      '<form id="vitalForm">' +
      '<div class="field-row">' +
      '<div class="field"><label for="sbp">高压（mmHg）</label><input id="sbp" type="number" min="70" max="250" value="135" required></div>' +
      '<div class="field"><label for="dbp">低压（mmHg）</label><input id="dbp" type="number" min="40" max="150" value="85" required></div>' +
      '<div class="field"><label for="pulse">心率（次/分）</label><input id="pulse" type="number" min="30" max="200" value="74"></div>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" type="button" data-mact="close">取消</button>' +
      '<button class="btn btn-primary" type="submit">保存</button></div>' +
      '</form>';
  }

  /* ---------------- 渲染 ---------------- */

  function renderMedRows(container, interactive) {
    if (!container) { return; }
    container.innerHTML = state.meds.map(function (m) {
      var st = medStatus(m);
      return '<div class="med-item">' +
        '<span class="med-time">' + m.time + '</span>' +
        '<div class="med-main"><strong>' + esc(m.short) + ' <em>' + esc(m.dose) + '</em></strong>' +
        '<small>' + esc(m.name) + ' · ' + esc(m.meal) + '</small></div>' +
        '<div class="med-right"><span class="med-state ' + st.key + '">' + esc(st.label) + '</span>' +
        (interactive && !m.takenAt && st.key === 'pending'
          ? '<button class="btn btn-primary btn-sm" type="button" data-med="' + m.id + '">确认已服用</button>'
          : '') +
        '</div></div>';
    }).join('');
  }

  function renderHome() {
    var n = now();
    $('#dateLine').textContent = (n.getMonth() + 1) + ' 月 ' + n.getDate() + ' 日 · ' + WEEK[n.getDay()];
    $('#clockLine').textContent = timeStr(n);
    $('#greetLine').textContent = state.profile.display + '，' + greetWord();

    var taken = takenCount();
    $('#medProgress').textContent = taken + ' / ' + state.meds.length;
    renderMedRows($('#medList'), true);

    var msgs = state.messages.filter(function (m) { return m.role === 'daughter'; }).slice(-2).reverse();
    $('#msgList').innerHTML = msgs.length ? msgs.map(function (m) {
      var isNew = m.id !== state.readMsgId && m.role === 'daughter';
      return '<div class="msg-item"><span class="msg-avatar">' + (m.role === 'daughter' ? '李' : '安') + '</span>' +
        '<div class="msg-body"><strong>' + esc(m.from) + (isNew ? ' <span class="tag tag-accent" style="font-size:.6rem">新</span>' : '') + '</strong>' +
        '<p>' + esc(m.text) + '</p><small>' + esc(m.time) + '</small></div></div>';
    }).join('') : '<p class="empty">还没有留言</p>';

    var alerts = activeAlerts();
    var rows = [
      { label: '雷达监测', value: state.consent.radar ? '在线' : '已关闭', on: state.consent.radar },
      { label: '燃气与烟雾', value: '正常', on: true },
      { label: '门窗', value: '已关', on: true },
      { label: '今日告警', value: alerts.length ? alerts.length + ' 条处理中' : '0 条', on: alerts.length === 0 },
      { label: '人工坐席', value: '7×24 在线', on: true }
    ];
    $('#safetyList').innerHTML = rows.map(function (r) {
      return '<li><span class="dot' + (r.on ? '' : ' off') + '"></span>' + r.label + '<b>' + r.value + '</b></li>';
    }).join('');

    renderConvo();
  }

  function renderConvo() {
    var box = $('#convo');
    if (!box) { return; }
    box.innerHTML = state.convo.map(function (m) {
      var me = m.role === 'user';
      var actions = '';
      if (m.actions && m.actions.length) {
        actions = '<div class="bubble-actions">' + m.actions.map(function (a) {
          return '<button type="button" data-act="' + esc(a.act) + '"' +
            (a.arg ? ' data-arg="' + esc(a.arg) + '"' : '') + '>' + esc(a.label) + '</button>';
        }).join('') + '</div>';
      }
      var music = m.kind === 'music'
        ? '<div class="music-card"><span class="music-icon"><svg class="ico" aria-hidden="true"><use href="#i-play"/></svg></span>' +
          '<div style="flex:1;min-width:0"><strong>豫剧《花木兰》选段</strong><small>演示音频，不含版权音乐</small>' +
          '<div class="music-bar"><i></i></div></div>' +
          '<button class="link-btn" type="button" data-act="music-stop">停止</button></div>'
        : '';
      return '<div class="bubble-row' + (me ? ' user' : '') + '">' +
        '<span class="bubble-avatar">' + (me ? '王' : '安') + '</span>' +
        '<div class="bubble-wrap"><div class="bubble">' + esc(m.text) + '</div>' + music + actions +
        '<div class="bubble-meta">' + esc(m.time || '') + '</div></div></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function weeklyAdherence() {
    return Math.round((state.weekly.taken / state.weekly.total) * 100);
  }

  function bpChart() {
    var data = state.vitals.slice(-7);
    if (data.length < 2) {
      return '<div class="empty">记录两次以上，就能看到血压趋势。</div>';
    }
    var W = 520;
    var H = 180;
    var P = 28;
    var sys = data.map(function (x) { return x.s; });
    var dia = data.map(function (x) { return x.d; });
    var min = Math.min.apply(null, dia) - 8;
    var max = Math.max.apply(null, sys) + 8;
    var x = function (i) { return P + i * (W - P * 2) / (data.length - 1); };
    var y = function (v) { return H - P - (v - min) / (max - min) * (H - P * 2); };
    var line = function (arr) {
      return arr.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
    };
    var dots = function (arr, cls) {
      return arr.map(function (v, i) {
        return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="3" fill="' + (cls === 'sys' ? '#2C6653' : '#A9531F') + '"></circle>';
      }).join('');
    };
    var labels = data.map(function (d, i) {
      if (i !== 0 && i !== data.length - 1 && data.length > 5) { return ''; }
      return '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11.5" fill="currentColor">' + d.date.slice(5) + '</text>';
    }).join('');
    var last = data[data.length - 1];
    return '<div class="chart-wrap">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="最近七天血压趋势，最近一次 ' + last.s + ' 比 ' + last.d + '">' +
      '<line x1="' + P + '" y1="' + y(max) + '" x2="' + (W - P) + '" y2="' + y(max) + '" stroke="currentColor" stroke-opacity=".12"/>' +
      '<line x1="' + P + '" y1="' + y(min) + '" x2="' + (W - P) + '" y2="' + y(min) + '" stroke="currentColor" stroke-opacity=".12"/>' +
      '<path d="' + line(sys) + '" fill="none" stroke="#2C6653" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<path d="' + line(dia) + '" fill="none" stroke="#A9531F" stroke-width="2" stroke-dasharray="4 4" stroke-linejoin="round"/>' +
      dots(sys, 'sys') + dots(dia, 'dia') + labels +
      '</svg></div>' +
      '<div class="chart-legend"><span>— 高压</span><span>-- 低压</span><span>最近 ' + last.s + '/' + last.d + ' mmHg</span></div>';
  }

  function renderFamily() {
    var taken = takenCount();
    var alerts = activeAlerts();
    var latest = state.vitals[state.vitals.length - 1];
    var share = !!state.consent.shareHealth;

    $('#familyGreeting').textContent = alerts.length
      ? '妈妈这边有 ' + alerts.length + ' 条告警，请先看看。'
      : '妈妈今天整体平稳。';

    $('#statGrid').innerHTML = [
      { label: '今日用药', value: taken + ' / ' + state.meds.length, note: taken === state.meds.length ? '已完成' : '还差 ' + (state.meds.length - taken) + ' 次', warn: false },
      { label: '待处理告警', value: String(alerts.length), note: alerts.length ? '需要关注' : '一切正常', warn: alerts.length > 0 },
      { label: '最新血压', value: share && latest ? (latest.s + '/' + latest.d) : '未授权', note: share && latest ? ('mmHg · ' + latest.date.slice(5)) : '请先获得授权', warn: false },
      { label: '本周通话', value: String(state.weekly.calls), note: '次 · 亲情联络', warn: false }
    ].map(function (s) {
      return '<div class="stat-card' + (s.warn ? ' warn' : '') + '"><small>' + s.label + '</small>' +
        '<strong>' + esc(s.value) + '</strong><span>' + esc(s.note) + '</span></div>';
    }).join('');

    $('#alertCount').textContent = alerts.length + ' 条待处理';
    $('#alertList').innerHTML = state.alerts.length ? state.alerts.slice(0, 6).map(function (a) {
      var cls = a.level === 'sos' ? ' is-sos' : (a.level === 'warn' ? ' is-warn' : '');
      var canResolve = a.status === '处理中' || a.status === '待处理';
      return '<div class="alert-item' + cls + '"><span class="sev"></span>' +
        '<div><div class="alert-title">' + esc(a.title) + '</div>' +
        '<div class="alert-detail">' + esc(a.detail) + '</div>' +
        '<div class="alert-meta">' + esc(a.time) + ' · ' + esc(a.status) + '</div></div>' +
        '<div class="alert-act">' + (canResolve
          ? '<button type="button" data-alert="' + a.id + '">标记已处理</button>'
          : '') + '</div></div>';
    }).join('') : '<div class="empty">今天没有需要处理的告警。</div>';

    if (!share) {
      $('#reportBody').innerHTML = '<div class="empty">妈妈撤回了健康数据授权。血压、趋势与用药依从性已对家属端隐藏。</div>' +
        '<div class="report-metrics" style="margin-top:.8rem">' +
        '<div class="report-metric"><span>亲情通话</span><strong>' + state.weekly.calls + ' 次 <em>本周</em></strong></div>' +
        '<div class="report-metric"><span>夜间离床</span><strong>' + state.weekly.nights + ' 次 <em>在正常范围</em></strong></div>' +
        '</div><p class="report-note">授权变更会语音告知老人，撤回即时生效。</p>';
    } else {
      $('#reportBody').innerHTML =
        '<div class="report-metrics">' +
        '<div class="report-metric"><span>用药确认</span><strong>' + state.weekly.taken + ' / ' + state.weekly.total + ' <em>' + weeklyAdherence() + '%</em></strong></div>' +
        '<div class="report-metric"><span>血压记录</span><strong>' + Math.min(7, state.vitals.length) + ' 次 <em>近 7 天</em></strong></div>' +
        '<div class="report-metric"><span>亲情通话</span><strong>' + state.weekly.calls + ' 次 <em>本周</em></strong></div>' +
        '<div class="report-metric"><span>夜间离床</span><strong>' + state.weekly.nights + ' 次 <em>在正常范围</em></strong></div>' +
        '</div>' + bpChart() +
        '<div class="mood-tags">' + state.moods.map(function (m) {
          return '<span class="tag">' + esc(m) + '</span>';
        }).join('') + '</div>' +
        '<p class="report-note">只呈现，不下结论；异常才标红。</p>';
    }

    var ft = takenCount();
    $('#familyMedProgress').textContent = ft + ' / ' + state.meds.length;
    renderMedRows($('#familyMedList'), false);

    $('#thread').innerHTML = state.messages.slice(-10).map(function (m) {
      var me = m.role === 'daughter';
      return '<div class="thread-item' + (me ? ' me' : '') + '">' +
        '<span class="msg-avatar">' + (me ? '李' : '安') + '</span>' +
        '<div class="thread-bubble">' + esc(m.text) + '<span class="thread-time">' + esc(m.time) + '</span></div></div>';
    }).join('');

    $$('[data-consent]').forEach(function (input) {
      input.checked = !!state.consent[input.dataset.consent];
    });

    $('#deviceList').innerHTML = [
      { label: '主机与 4G 备份', value: '在线', on: true },
      { label: '毫米波雷达', value: state.consent.radar ? '在线' : '已关闭', on: state.consent.radar },
      { label: '燃气 / 烟感 / 门磁', value: '正常', on: true },
      { label: '人工坐席', value: '7×24', on: true },
      { label: '最近心跳', value: '刚刚', on: true }
    ].map(function (d) {
      return '<li><span class="dot' + (d.on ? '' : ' off') + '"></span>' + d.label + '<b>' + d.value + '</b></li>';
    }).join('');
  }

  function renderAll() {
    renderHome();
    renderFamily();
  }

  /* ---------------- 视图与设置 ---------------- */

  function setView(next, announce) {
    view = next;
    $$('.view').forEach(function (el) {
      el.hidden = el.id !== 'view-' + next;
    });
    $$('.role-btn').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.view === next ? 'true' : 'false');
    });
    if (next === 'family') {
      renderFamily();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      renderHome();
      if (announce) { speakUnread(); }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    try { history.replaceState(null, '', '#' + next); } catch (e) { /* ignore */ }
  }

  function speakUnread() {
    var latest = lastDaughterMsg();
    if (!latest || latest.id === state.readMsgId) { return; }
    state.readMsgId = latest.id;
    save();
    renderHome();
    window.setTimeout(function () {
      speak('李女士给您留言：' + latest.text);
      toast('有新留言，我读给您听');
    }, 350);
  }

  function applySettings() {
    document.documentElement.classList.toggle('senior', !!state.settings.senior);
    document.documentElement.classList.toggle('hc', !!state.settings.contrast);
    var btn = $('#bigTextBtn');
    if (btn) { btn.setAttribute('aria-pressed', state.settings.senior ? 'true' : 'false'); }
    save();
  }

  /* ---------------- 动作 ---------------- */

  function runAction(act, arg) {
    if (act === 'med') { confirmMed(arg); return; }
    if (act === 'call') { startCall(); return; }
    if (act === 'sos') { startSOS('action'); return; }
    if (act === 'notify') { notifyFamily(); return; }
    if (act === 'seat') { seat(); return; }
    if (act === 'dismiss') {
      addAi('好，您先歇着。有不舒服，随时叫我。');
      return;
    }
    if (act === 'chat') {
      addAi('好。您年轻的时候，最常去的是哪儿？我听着。');
      return;
    }
    if (act === 'help') { openHelp(); return; }
    if (act === 'record') { openVital(); return; }
    if (act === 'music-stop') {
      for (var i = state.convo.length - 1; i >= 0; i--) {
        if (state.convo[i].kind === 'music') {
          state.convo[i].kind = 'text';
          state.convo[i].text = '已停止播放。想听别的跟我说。';
          break;
        }
      }
      save();
      renderConvo();
      speak('好，停了。');
      return;
    }
    if (act === 'vital-yes') {
      if (pendingVital) {
        var v = pendingVital;
        pendingVital = null;
        saveVital(v.s, v.d, v.p);
      }
      return;
    }
    if (act === 'vital-no') {
      pendingVital = null;
      addAi('好，那这次不记。您再说一次，比如“血压 135 85”。');
      return;
    }
  }

  function openHelp() { openModal(helpHTML()); }
  function openSettings() { openModal(settingsHTML()); }
  function openCard() { openModal(emergencyCardHTML()); }
  function openVital() {
    openModal(vitalModalHTML());
    var form = $('#vitalForm');
    if (!form) { return; }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var s = Number($('#sbp').value);
      var d = Number($('#dbp').value);
      var p = Number($('#pulse').value) || 74;
      if (!s || !d || s < 70 || s > 250 || d < 40 || d > 150 || d >= s) {
        toast('数值看起来不对，请检查高压和低压');
        return;
      }
      closeModal(true);
      saveVital(s, d, p);
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    $('#talkBtn').addEventListener('click', startListening);

    $('#sayForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('#sayInput');
      var text = input.value.trim();
      if (!text) { return; }
      input.value = '';
      handleText(text);
    });

    $('#quickChips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) { return; }
      if (chip.dataset.sos) { startSOS('chip'); return; }
      if (chip.dataset.say) { handleText(chip.dataset.say); }
    });

    var sosBtn = $('#sosBtn');
    if (sosBtn) {
      sosBtn.addEventListener('click', function () { startSOS('button'); });
    }

    document.addEventListener('click', function (e) {
      var med = e.target.closest('[data-med]');
      if (med) { confirmMed(med.dataset.med); return; }
      var alertBtn = e.target.closest('[data-alert]');
      if (alertBtn) {
        var item = state.alerts.filter(function (a) { return a.id === alertBtn.dataset.alert; })[0];
        if (item) {
          item.status = '已闭环';
          item.closedAt = now().getTime();
          save();
          renderAll();
          toast('已标记处理');
        }
        return;
      }
      var actBtn = e.target.closest('[data-act]');
      if (actBtn) { runAction(actBtn.dataset.act, actBtn.dataset.arg); return; }
    });

    $$('.role-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setView(btn.dataset.view, btn.dataset.view === 'home');
      });
      btn.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') { return; }
        e.preventDefault();
        var buttons = $$('.role-btn');
        var index = buttons.indexOf(btn);
        var next = (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
        setView(buttons[next].dataset.view, buttons[next].dataset.view === 'home');
      });
    });

    $('#bigTextBtn').addEventListener('click', function () {
      state.settings.senior = !state.settings.senior;
      applySettings();
      toast(state.settings.senior ? '大字模式已开启' : '大字模式已关闭');
    });

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#helpBtn').addEventListener('click', openHelp);
    $('#helpBtn2').addEventListener('click', openHelp);
    $('#helpLink').addEventListener('click', function (e) { e.preventDefault(); openHelp(); });
    $('#recordVitalBtn').addEventListener('click', openVital);
    $('#emergencyCardBtn').addEventListener('click', openCard);

    $('#seatBtn').addEventListener('click', function () {
      seat();
    });

    $('#speakMsgBtn').addEventListener('click', function () {
      var m = lastDaughterMsg();
      if (!m) { toast('还没有留言'); return; }
      state.readMsgId = m.id;
      save();
      renderHome();
      speak('李女士给您留言：' + m.text);
    });

    $('#composeForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('#composeInput');
      var text = input.value.trim();
      if (!text) { return; }
      state.messages.push({
        id: uid('msg'), from: '李梅', role: 'daughter', text: text, time: '刚刚'
      });
      input.value = '';
      save();
      renderAll();
      toast('已发送；切回老人端会读给妈妈听');
    });

    document.addEventListener('change', function (e) {
      var key = e.target.dataset ? e.target.dataset.consent : null;
      if (key) {
        state.consent[key] = e.target.checked;
        save();
        renderAll();
        toast(key === 'shareHealth'
          ? (e.target.checked ? '已授权查看健康数据' : '已撤回，家属端隐藏健康数据')
          : (e.target.checked ? '已开启' : '已关闭'));
        return;
      }
      var setting = e.target.dataset ? e.target.dataset.setting : null;
      if (setting === 'senior' || setting === 'contrast' || setting === 'voice') {
        state.settings[setting] = e.target.checked;
        applySettings();
      }
    });

    $('#modalBackdrop').addEventListener('click', function (e) {
      if (e.target === $('#modalBackdrop') && !modalLocked) { closeModal(); }
    });

    $('#modalBody').addEventListener('input', function (e) {
      if (e.target.id === 'rateInput') {
        state.settings.rate = Number(e.target.value);
        var label = $('#rateVal');
        if (label) { label.textContent = Number(e.target.value).toFixed(2) + '×'; }
        save();
      }
    });

    $('#modalBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-mact]');
      if (!btn) { return; }
      var act = btn.dataset.mact;
      if (act === 'close') { closeModal(); }
      else if (act === 'sos-cancel') { cancelSOS(); }
      else if (act === 'sos-now') {
        if (sos && sos.timer) { window.clearInterval(sos.timer); }
        if (sos) { sos.left = 0; }
        triggerSOS();
      } else if (act === 'sos-end') { endSOS(); }
      else if (act === 'call-hang') { endCall(); }
      else if (act === 'reset') {
        if (window.confirm('清除本机演示数据并恢复初始状态？')) {
          try { window.localStorage.removeItem(KEY); } catch (err) { /* ignore */ }
          state = seed();
          seedGreeting();
          applySettings();
          renderAll();
          closeModal(true);
          setView('home', false);
          toast('已恢复初始数据');
        }
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !$('#modalBackdrop').hidden) {
        var focusables = $$('button, input, [href], select, textarea', $('#modalBox')).filter(function (el) {
          return !el.disabled && el.offsetParent !== null;
        });
        if (focusables.length) {
          var first = focusables[0];
          var last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (e.key !== 'Escape') { return; }
      if (sos && sos.phase === 'countdown') { cancelSOS(); return; }
      if (sos && sos.phase === 'active') { return; }
      if (call) { endCall(); return; }
      if (!$('#modalBackdrop').hidden && !modalLocked) { closeModal(); }
    });

    window.addEventListener('storage', function (e) {
      if (e.key !== KEY) { return; }
      state = load();
      applySettings();
      renderAll();
      if (view === 'family') { renderFamily(); }
    });

    window.addEventListener('pagehide', function () {
      if (synth) { try { synth.cancel(); } catch (e) { /* ignore */ } }
      if (sos) {
        (sos.timeouts || []).forEach(function (t) { window.clearTimeout(t); });
        if (sos.timer) { window.clearInterval(sos.timer); }
      }
      if (call && call.timer) { window.clearInterval(call.timer); }
    });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    state = load();
    var storageOK = true;
    try {
      window.localStorage.setItem('__anyu_probe', '1');
      window.localStorage.removeItem('__anyu_probe');
    } catch (e) {
      storageOK = false;
    }
    if (!storageOK) {
      var warn = $('#storageWarn');
      if (warn) { warn.hidden = false; }
    }
    state.logs = state.logs || [];
    state.moods = state.moods || [];
    state.readMsgId = state.readMsgId || '';
    state.settings = Object.assign({ senior: false, contrast: false, voice: true, rate: 0.85 }, state.settings || {});
    state.consent = Object.assign({ shareHealth: true, radar: true, location: false }, state.consent || {});
    state.weekly = Object.assign({ total: 21, taken: 19, calls: 4, nights: 2 }, state.weekly || {});
    if (!state.convo || !state.convo.length) { seedGreeting(); }
    applySettings();
    bind();
    renderAll();

    var hash = (window.location.hash || '').replace('#', '');
    setView(hash === 'family' ? 'family' : 'home', false);

    window.setInterval(function () {
      var n = now();
      var clock = $('#clockLine');
      var date = $('#dateLine');
      if (clock) { clock.textContent = timeStr(n); }
      if (date) { date.textContent = (n.getMonth() + 1) + ' 月 ' + n.getDate() + ' 日 · ' + WEEK[n.getDay()]; }
      var greet = $('#greetLine');
      if (greet) { greet.textContent = state.profile.display + '，' + greetWord(); }
      if (view === 'home') {
        var progress = $('#medProgress');
        if (progress) { progress.textContent = takenCount() + ' / ' + state.meds.length; }
        renderMedRows($('#medList'), true);
      }
    }, 30000);

    save();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
