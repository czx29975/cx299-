/* =========================================================
   安语 · 社区值守台
   与老人端共用 localStorage('anyu.app.v1') 中的 alerts
   工单状态机：待处理 → 处理中 → 已闭环
   ========================================================= */
(function () {
  'use strict';

  var KEY = 'anyu.app.v1';
  var ME = '王建国 · 网格员';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var hhmm = function (d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  var state = null;
  var tab = 'open';
  var selected = null;
  var storageOK = true;
  var tickTimer = null;

  /* ---------------- 数据读写 ---------------- */

  function seedFallback() {
    return { profile: { name: '王秀兰', display: '王阿姨', age: 78 }, alerts: [], meds: [] };
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && Array.isArray(d.alerts)) { return d; }
      }
      storageOK = true;
      return seedFallback();
    } catch (e) {
      storageOK = false;
      return seedFallback();
    }
  }

  function save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
      storageOK = true;
    } catch (e) {
      storageOK = false;
      toast('本地存储不可用，这次改动不会保存。请用 Chrome / Edge 或本地服务器打开。', true);
    }
    var live = $('#liveState');
    if (live) { live.classList.toggle('is-off', !storageOK); }
  }

  /* ---------------- 工单模型 ---------------- */

  // 把老人端写入的 alert 归一成工单
  function tickets() {
    return (state.alerts || []).map(function (a) {
      var phase = a.status === '待处理' ? 'open'
        : a.status === '处理中' ? 'doing' : 'done';
      return {
        raw: a,
        id: a.id,
        phase: phase,
        sos: a.level === 'sos',
        title: a.title || '未命名事件',
        detail: a.detail || '',
        time: a.time || '',
        raisedAt: a.raisedAt || null,
        assignee: a.assignee || '',
        acceptedAt: a.acceptedAt || null,
        closedAt: a.closedAt || null,
        log: Array.isArray(a.log) ? a.log : []
      };
    });
  }

  function byPhase(ph) {
    return tickets().filter(function (t) { return t.phase === ph; });
  }

  // 响应时限：SOS 60 秒必须有人接，其他告警 5 分钟
  function slaMs(t) { return t.sos ? 60 * 1000 : 5 * 60 * 1000; }

  function fmtDur(ms) {
    var abs = Math.abs(ms);
    var s = Math.round(abs / 1000);
    if (s < 60) { return s + ' 秒'; }
    var m = Math.floor(s / 60);
    if (m < 60) { return m + ' 分 ' + pad(s % 60) + ' 秒'; }
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }

  function slaText(t) {
    if (!t.raisedAt) { return { text: t.phase === 'done' ? '已归档' : '演示数据', cls: '' }; }
    if (t.phase === 'done') { return { text: '已闭环', cls: 'is-ok' }; }
    if (t.phase === 'doing') {
      var used = Date.now() - t.raisedAt;
      return { text: '已处理 ' + fmtDur(used), cls: '' };
    }
    var left = slaMs(t) - (Date.now() - t.raisedAt);
    return left >= 0
      ? { text: '响应剩 ' + fmtDur(left), cls: '' }
      : { text: '已超时 ' + fmtDur(left), cls: 'is-over' };
  }

  /* ---------------- 渲染：概览 ---------------- */

  function renderKPIs() {
    var open = byPhase('open').length;
    var doing = byPhase('doing').length;
    var done = byPhase('done').length;
    var over = byPhase('open').filter(function (t) {
      return t.raisedAt && Date.now() - t.raisedAt > slaMs(t);
    }).length;

    var data = [
      { k: '待接单', v: open, s: open === 0 ? '全部已接手' : (over ? over + ' 条已超时' : '均在时限内'), cls: open === 0 ? 'is-good' : 'is-alert', w: open ? Math.min(100, open * 34 + 8) : 100 },
      { k: '处理中', v: doing, s: doing ? '责任人已锁定' : '暂无进行中工单', cls: doing ? 'is-doing' : 'is-good', w: doing ? Math.min(100, doing * 34 + 8) : 100 },
      { k: '今日已闭环', v: done, s: '含自动恢复', cls: 'is-good', w: Math.min(100, done * 18 + 10) },
      { k: '平均到场', v: '8.5', s: '分钟 · 目标 ≤10', cls: 'is-good', w: 78 }
    ];

    $('#kpis').innerHTML = data.map(function (d) {
      return '<div class="ct-kpi ' + d.cls + '">' +
        '<b>' + esc(d.v) + '</b>' +
        '<span>' + esc(d.k) + ' · ' + esc(d.s) + '</span>' +
        '<i style="--w:' + d.w + '%"></i>' +
        '</div>';
    }).join('');

    $('#nOpen').textContent = open;
    $('#nDoing').textContent = doing;
    $('#nDone').textContent = done;

    var title = $('#ctTitle');
    if (title) {
      var n = open + doing;
      title.innerHTML = n
        ? '今晚，<em>' + n + '</em> 件事需要有人接得住。'
        : '今晚，<em>暂时没有</em>待处理的求助。';
    }
  }

  /* ---------------- 渲染：工单列表 ---------------- */

  var ICON = {
    sos: '<svg class="ico" aria-hidden="true"><use href="#i-alert"/></svg>',
    warn: '<svg class="ico" aria-hidden="true"><use href="#i-wifi"/></svg>',
    info: '<svg class="ico" aria-hidden="true"><use href="#i-clock"/></svg>'
  };

  function renderList() {
    var list = byPhase(tab);
    var box = $('#ticketList');
    $('#listEmpty').hidden = list.length > 0;

    box.innerHTML = list.map(function (t) {
      var sla = slaText(t);
      var lv = t.sos ? 'sos' : (t.raw.level === 'warn' ? 'warn' : 'info');
      return '<button type="button" class="ct-ticket' + (t.sos ? ' is-sos' : '') +
        (selected === t.id ? ' is-sel' : '') + '" data-id="' + esc(t.id) + '">' +
        '<span class="ct-ticket-ico">' + (ICON[lv] || ICON.info) + '</span>' +
        '<span class="ct-ticket-main">' +
          '<span class="ct-ticket-title">' + esc(t.title) + '</span>' +
          '<span class="ct-ticket-meta">' + esc(t.time || '时间未记录') +
            (t.assignee ? '<span class="sep">·</span>' + esc(t.assignee) : '') +
          '</span>' +
        '</span>' +
        '<span class="ct-ticket-right">' +
          '<span class="ct-badge is-' + t.phase + '">' +
            (t.phase === 'open' ? '待接单' : t.phase === 'doing' ? '处理中' : '已闭环') + '</span>' +
          '<span class="ct-sla ' + sla.cls + '" data-sla="' + esc(t.id) + '">' + esc(sla.text) + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
  }

  /* ---------------- 渲染：详情 ---------------- */

  function findTicket(id) {
    return tickets().filter(function (t) { return t.id === id; })[0] || null;
  }

  function timeline(t) {
    var steps = [];
    var raised = t.raisedAt ? new Date(t.raisedAt) : null;

    steps.push({
      state: 'done', b: '事件触发',
      small: (raised ? hhmm(raised) : t.time || '—') + ' · ' + (t.sos ? '语音求助 / 雷达事件' : '设备或语音上报')
    });
    steps.push({
      state: t.raisedAt ? 'done' : 'idle', b: '推送家属',
      small: t.raisedAt ? '李梅（女儿）已收到电话与短信' : '待事件触发后自动执行'
    });
    steps.push({
      state: t.acceptedAt ? 'done' : (t.phase === 'open' ? 'now' : 'idle'),
      b: '社区接单',
      small: t.acceptedAt ? hhmm(new Date(t.acceptedAt)) + ' · ' + (t.assignee || ME) : '等待值守人员接单'
    });

    t.log.forEach(function (l) {
      steps.push({ state: 'done', b: l.text, small: l.t || '' });
    });

    steps.push({
      state: t.phase === 'done' ? 'done' : 'idle',
      b: '结案归档',
      small: t.closedAt ? hhmm(new Date(t.closedAt)) + ' · 已留痕' : '处理完成后归档，全程可追溯'
    });
    return steps;
  }

  function renderDetail() {
    var t = selected ? findTicket(selected) : null;
    $('#detailEmpty').hidden = !!t;
    var body = $('#detailBody');
    body.hidden = !t;
    if (!t) { body.innerHTML = ''; return; }

    var p = state.profile || {};
    var contact = p.contact || {};
    var sla = slaText(t);

    var actions = '';
    if (t.phase === 'open') {
      actions = '<button class="btn btn-primary btn-sm" data-act="accept">接单（' + esc(ME.split(' · ')[0]) + '）</button>' +
                '<button class="btn btn-ghost btn-sm" data-act="family">联系家属</button>';
    } else if (t.phase === 'doing') {
      actions = '<button class="btn btn-primary btn-sm" data-act="arrive">标记已到场</button>' +
                '<button class="btn btn-ghost btn-sm" data-act="call120">转 120</button>' +
                '<button class="btn btn-ghost btn-sm" data-act="close">结案</button>';
    } else {
      actions = '<button class="btn btn-ghost btn-sm" data-act="reopen">重新打开</button>';
    }

    var when = t.raisedAt ? '今天 ' + hhmm(new Date(t.raisedAt)) : (t.time || '');
    body.innerHTML =
      '<div class="ct-d-head">' +
        '<div><h3 class="ct-d-title">' + esc(t.title) + '</h3>' +
        '<p class="ct-d-sub">' + esc(when) + ' · ' + esc(t.assignee || '未指派') + ' · <span class="' +
          (sla.cls === 'is-over' ? 'ct-sla is-over' : '') + '">' + esc(sla.text) + '</span></p></div>' +
        '<span class="ct-badge is-' + t.phase + '">' +
          (t.phase === 'open' ? '待接单' : t.phase === 'doing' ? '处理中' : '已闭环') + '</span>' +
      '</div>' +
      (t.detail ? '<p class="ct-d-sub">' + esc(t.detail) + '</p>' : '') +

      '<div class="ct-d-block"><p class="ct-d-label">事件时间线</p><ul class="ct-tl">' +
        timeline(t).map(function (s) {
          return '<li class="' + (s.state === 'done' ? 'is-done' : s.state === 'now' ? 'is-now' : '') + '">' +
            '<span class="ct-tl-dot"></span><span class="ct-tl-text"><b>' + esc(s.b) + '</b><small>' + esc(s.small) + '</small></span></li>';
        }).join('') +
      '</ul></div>' +

      '<div class="ct-d-block"><p class="ct-d-label">应急信息卡 · 已脱敏</p>' +
        '<dl class="ct-info">' +
          '<div><dt>姓名</dt><dd>' + esc(p.name || '—') + '（' + esc(p.age || '—') + ' 岁）</dd></div>' +
          '<div><dt>血型</dt><dd>' + esc(p.bloodType || '—') + '</dd></div>' +
          '<div><dt>住址</dt><dd>' + esc(p.address || '—') + '</dd></div>' +
          '<div><dt>基础病</dt><dd>' + esc(p.conditions || '—') + '</dd></div>' +
          '<div><dt>过敏</dt><dd>' + esc(p.allergies || '—') + '</dd></div>' +
          '<div><dt>家属</dt><dd>' + esc(contact.name || '—') + ' · ' + esc(contact.phone || '—') + '</dd></div>' +
        '</dl>' +
        '<p class="ct-d-note">只有接单后的责任人可见完整病房信息；每次查看都会记账。</p>' +
      '</div>' +

      '<div class="ct-actions">' + actions + '</div>';
  }

  /* ---------------- 动作 ---------------- */

  function act(kind) {
    var t = selected ? findTicket(selected) : null;
    if (!t) { return; }
    var a = t.raw;
    var now = Date.now();

    if (kind === 'accept') {
      a.status = '处理中';
      a.assignee = ME;
      a.acceptedAt = now;
      a.log = (a.log || []).concat([{ t: hhmm(new Date()), text: '王建国接单，正在赶往 3 单元 402' }]);
      toast('已接单，家属端同步显示"社区已接手"。');
    } else if (kind === 'arrive') {
      a.log = (a.log || []).concat([{ t: hhmm(new Date()), text: '已到场，老人意识清醒，无外伤' }]);
      toast('已记录到场。若情况超出能力范围，请转 120。');
    } else if (kind === 'call120') {
      a.log = (a.log || []).concat([{ t: hhmm(new Date()), text: '已转 120，地址与信息卡已推送' }]);
      toast('已转 120（演示）。真实产品会同时通知家属与值班长。');
    } else if (kind === 'close') {
      a.status = '已闭环';
      a.closedAt = now;
      a.log = (a.log || []).concat([{ t: hhmm(new Date()), text: '结案：已确认安全，家属已回电' }]);
      toast('工单已闭环，事件已留痕。');
      setTab('done');
    } else if (kind === 'reopen') {
      a.status = '待处理';
      a.closedAt = null;
      a.log = (a.log || []).concat([{ t: hhmm(new Date()), text: '重新打开工单，需复核' }]);
      setTab('open');
      toast('已重新打开。');
    } else if (kind === 'family') {
      toast('正在呼叫 ' + ((state.profile.contact || {}).name || '家属') + '（演示，不会真的拨号）。');
      return;
    }

    save();
    renderAll();
  }

  /* ---------------- 名册 ---------------- */

  var ROSTER = [
    { name: '王秀兰', meta: '78 岁 · 独居', addr: '3 单元 402', tags: [['独居', 'risk'], ['高血压', 'chronic'], ['糖尿病', 'chronic']], device: '在线', last: '今晚 18:30 用药未确认', med: 'live' },
    { name: '张桂芳', meta: '82 岁 · 与老伴同住', addr: '1 单元 201', tags: [['高龄', 'chronic']], device: '在线', last: '昨天 雷达夜起 1 次', med: '2 / 2' },
    { name: '李长海', meta: '75 岁 · 独居', addr: '2 单元 303', tags: [['独居', 'risk'], ['冠心病', 'chronic']], device: '离线 2h', last: '设备离线，已建单待上门', med: '1 / 3' },
    { name: '赵玉兰', meta: '69 岁 · 与子女同住', addr: '3 单元 102', tags: [['术后康复', 'chronic']], device: '在线', last: '今天 09:20 血压已记录', med: '3 / 3' },
    { name: '陈建国', meta: '80 岁 · 独居', addr: '5 单元 401', tags: [['独居', 'risk'], ['听力下降', 'chronic']], device: '在线', last: '今天 07:05 主动问早', med: '2 / 2' },
    { name: '孙秀英', meta: '77 岁 · 与保姆同住', addr: '5 单元 203', tags: [['认知障碍', 'risk']], device: '在线', last: '昨天 走失预警已解除', med: '2 / 2' }
  ];

  function renderRoster() {
    var p = state.profile || {};
    var taken = (state.meds || []).filter(function (m) { return m.takenAt; }).length;
    var total = (state.meds || []).length || 3;

    $('#rosterBody').innerHTML = ROSTER.map(function (r, i) {
      var isSelf = i === 0;
      var med = isSelf ? taken + ' / ' + total : r.med;
      var offline = r.device.indexOf('离线') >= 0;
      return '<tr>' +
        '<td><span class="ct-person"><span class="ct-avatar">' + esc(r.name.slice(0, 1)) + '</span>' +
          '<span><b>' + esc(r.name) + '</b><small>' + esc(r.meta) + '</small></span></span></td>' +
        '<td>' + esc(r.addr) + '</td>' +
        '<td><span class="ct-tags">' + r.tags.map(function (tg) {
          return '<span class="ct-tag is-' + tg[1] + '">' + esc(tg[0]) + '</span>';
        }).join('') + '</span></td>' +
        '<td><span class="ct-state' + (offline ? ' is-off' : '') + '"><i class="dot"></i>' + esc(r.device) + '</span></td>' +
        '<td>' + esc(isSelf && taken < total ? '今晚 18:30 用药未确认' : r.last) + '</td>' +
        '<td>' + esc(med) + '</td>' +
      '</tr>';
    }).join('');
  }

  /* ---------------- 指标 ---------------- */

  var BARS_A = [['紧急求助', 4, 26], ['设备离线', 3, 20], ['语音主诉', 3, 20], ['用药未确认', 2, 13]];
  var BARS_B = [['≤30 秒', 7, 47], ['30–60 秒', 4, 27], ['1–3 分钟', 3, 20], ['>3 分钟', 1, 6]];

  function bars(id, data, accentFrom) {
    var max = Math.max.apply(null, data.map(function (d) { return d[1]; }));
    $(id).innerHTML = data.map(function (d, i) {
      return '<li' + (i >= (accentFrom || 99) ? ' class="is-accent"' : '') + '>' +
        '<span class="lab">' + esc(d[0]) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + Math.round(d[1] / max * 100) + '%"></span></span>' +
        '<span class="val">' + esc(d[2]) + '%</span></li>';
    }).join('');
  }

  /* ---------------- 提示 ---------------- */

  function toast(msg, warn) {
    var wrap = $('#toastWrap');
    if (!wrap) { return; }
    var el = document.createElement('div');
    el.className = 'ct-toast' + (warn ? ' is-warn' : '');
    el.textContent = msg;
    wrap.appendChild(el);
    window.setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      window.setTimeout(function () { el.remove(); }, 320);
    }, 3200);
  }

  /* ---------------- 事件绑定 ---------------- */

  function setTab(name) {
    tab = name;
    $$('.ct-tab').forEach(function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderList();
  }

  function bind() {
    $$('.ct-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { setTab(btn.dataset.tab); });
    });

    $('#ticketList').addEventListener('click', function (e) {
      var card = e.target.closest('[data-id]');
      if (!card) { return; }
      selected = card.dataset.id;
      renderList();
      renderDetail();
    });

    $('#detailBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) { return; }
      act(btn.dataset.act);
    });

    $('#seedTicket').addEventListener('click', function () {
      var now = Date.now();
      var alert = {
        id: 'sos-demo-' + now.toString(36),
        level: 'sos',
        title: '紧急求助 · 语音触发（演示）',
        detail: '老人在客厅说："我摔了，起不来。"已启动三级联动，家属电话未接通。',
        time: '今天 ' + hhmm(new Date()),
        status: '待处理',
        raisedAt: now,
        assignee: '',
        log: []
      };
      state.alerts.unshift(alert);
      save();
      selected = alert.id;
      setTab('open');
      renderAll();
      toast('已生成一条求助工单，试试接单 → 到场 → 转 120 → 结案。');
    });

    // 跨标签同步：老人端/家属端改动后自动刷新
    window.addEventListener('storage', function (e) {
      if (e.key !== KEY) { return; }
      state = load();
      if (selected && !findTicket(selected)) { selected = null; }
      renderAll();
    });
  }

  /* ---------------- 启动 ---------------- */

  function renderAll() {
    renderKPIs();
    renderList();
    renderDetail();
    renderRoster();
  }

  function boot() {
    state = load();
    $('#liveState').classList.toggle('is-off', !storageOK);

    // 深链：community.html?t=<工单号> 直接打开某条工单
    var m = /[?&]t=([^&]+)/.exec(window.location.search);
    if (m) {
      var want = decodeURIComponent(m[1]);
      var hit = findTicket(want);
      if (hit) { selected = want; tab = hit.phase; }
    }
    bars('#barChart', BARS_A);
    bars('#barChart2', BARS_B, 3);
    bind();
    $$('.ct-tab').forEach(function (b) {
      var on = b.dataset.tab === tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderAll();

    // 倒计时：只更新文本，避免整表重绘
    tickTimer = window.setInterval(function () {
      $$('[data-sla]').forEach(function (el) {
        var t = findTicket(el.dataset.sla);
        if (!t) { return; }
        var s = slaText(t);
        if (el.textContent !== s.text) { el.textContent = s.text; }
        el.classList.toggle('is-over', s.cls === 'is-over');
        el.classList.toggle('is-ok', s.cls === 'is-ok');
      });
      renderKPIs();
    }, 1000);

    window.addEventListener('beforeunload', function () {
      if (tickTimer) { window.clearInterval(tickTimer); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
