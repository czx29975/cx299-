/* 家属端：概览、告警处理、用药、留言、授权、周报 */
(function () {
  'use strict';

  var me = null;
  var summary = null;
  var messages = [];
  var plan = [];
  var knownAlerts = null;

  /* ---------- 小工具 ---------- */

  function modalForm(opts) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'backdrop';
      back.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
          '<h2>' + esc(opts.title) + '</h2>' +
          (opts.desc ? '<p class="small muted" style="margin-bottom:.8rem">' + esc(opts.desc) + '</p>' : '') +
          '<form id="mf">' + opts.fields + '<div class="modal-actions">' +
            '<button class="btn btn-ghost" type="button" data-no>取消</button>' +
            '<button class="btn btn-primary" type="submit">' + esc(opts.ok || '确定') + '</button>' +
          '</div></form>' +
        '</div>';
      function done(v) { back.remove(); resolve(v); }
      back.addEventListener('click', function (e) {
        if (e.target === back || e.target.hasAttribute('data-no')) { done(null); }
      });
      back.querySelector('#mf').addEventListener('submit', function (e) {
        e.preventDefault();
        var out = {};
        $$('[data-f]', back).forEach(function (i) { out[i.dataset.f] = i.value.trim(); });
        done(out);
      });
      document.body.appendChild(back);
      var first = back.querySelector('input, textarea');
      if (first) { first.focus(); }
    });
  }

  /* ---------- 渲染 ---------- */

  function renderStats() {
    var rep = summary.report;
    var vital = summary.vital;
    var vitalTxt = vital ? vital.sys + '/' + vital.dia : '—';
    var vitalSub = vital ? relTime(vital.measured_at) : (rep.hidden ? '老人已关闭共享' : '还没有记录');
    var openN = summary.open_alerts.length;
    var stats = [
      { v: summary.med_progress.taken + ' / ' + summary.med_progress.total, s: '今日用药', cls: summary.med_progress.taken === summary.med_progress.total && summary.med_progress.total ? 'ok' : '' },
      { v: String(openN), s: '待处理告警', cls: openN ? 'alert' : 'ok' },
      { v: vitalTxt, s: '最新血压 · ' + vitalSub, cls: '' },
      { v: String(rep.messages || 0), s: '近 7 天留言', cls: '' }
    ];
    $('#stats').innerHTML = stats.map(function (s) {
      return '<div class="stat ' + s.cls + '"><b>' + esc(s.v) + '</b><span>' + esc(s.s) + '</span></div>';
    }).join('');
  }

  function renderAlerts() {
    var items = summary.open_alerts || [];
    $('#alertCount').textContent = items.length ? items.length + ' 条待处理' : '暂无';
    var box = $('#alertList');
    if (!items.length) {
      box.innerHTML = '<div class="empty">目前没有需要处理的告警。</div>';
      return;
    }
    box.innerHTML = items.map(function (a) {
      var cls = a.level === 'sos' ? 'sos' : (a.level === 'warn' ? 'warn' : '');
      var status = { pending: '待接单', accepted: '已接单', arrived: '已到场', closed: '已结案' }[a.status] || a.status;
      return '<div class="alert-item ' + cls + '">' +
        '<div class="alert-top"><b>' + esc(a.title) + '</b><span class="tag ' +
          (a.level === 'sos' ? 'tag-danger' : 'tag-warn') + '">' + esc(status) + '</span></div>' +
        (a.detail ? '<p>' + esc(a.detail) + '</p>' : '') +
        '<p class="alert-meta">' + esc(relTime(a.raised_at)) + (a.assignee_name ? ' · ' + esc(a.assignee_name) : '') + '</p>' +
        '<div style="display:flex;gap:.4rem;margin-top:.5rem">' +
          '<button class="btn btn-ghost btn-sm" data-note="' + a.id + '">补充说明</button>' +
          '<button class="btn btn-ghost btn-sm" data-close="' + a.id + '">标记已处理</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderMeds() {
    var items = summary.meds || [];
    $('#medProgress').textContent = summary.med_progress.taken + ' / ' + summary.med_progress.total;
    if (!items.length) {
      $('#medList').innerHTML = '<p class="muted small">还没有登记用药。</p>';
      return;
    }
    $('#medList').innerHTML = items.map(function (m) {
      var tag = m.state === 'taken' ? 'tag-ok' : (m.state === 'late' ? 'tag-danger' : (m.state === 'due' ? 'tag-warn' : ''));
      var label = m.state === 'taken' ? (hhmm(m.taken_at) + ' 已吃')
        : m.state === 'late' ? '已过点未确认'
        : m.state === 'due' ? '到点未确认' : '未到时间';
      return '<div class="med-row ' + (m.state === 'taken' ? 'taken' : '') + '">' +
        '<div class="med-main"><b>' + esc(m.name) + '</b><small>' + esc(m.time) + ' · ' + esc(m.dose || '') + ' ' + esc(m.meal || '') + '</small></div>' +
        (m.state === 'taken'
          ? '<span class="tag ' + tag + '">' + esc(label) + '</span>'
          : '<button class="btn btn-ghost btn-sm" data-medconfirm="' + m.id + '">代确认</button>') +
      '</div>';
    }).join('');
  }

  function renderPlan(items) {
    var box = $('#planList');
    if (!items || !items.length) {
      box.innerHTML = '<div class="empty">还没有用药计划。点右上角「+ 加一种」。</div>';
      return;
    }
    box.innerHTML = items.map(function (m) {
      return '<div class="med-row">' +
        '<div class="med-main"><b>' + esc(m.name) + '</b>' +
          '<small>' + esc(m.time_hhmm) + ' · ' + esc(m.dose || '') +
          (m.meal ? ' · ' + esc(m.meal) : '') + '</small></div>' +
        '<button class="btn btn-ghost btn-sm" data-editmed="' + m.id + '">改</button>' +
        '<button class="icon-btn" type="button" data-delmed="' + m.id + '" aria-label="删除' + esc(m.name) + '">✕</button>' +
      '</div>';
    }).join('');
  }

  function renderSymptoms() {
    var box = $('#symptomList');
    if (!box) { return; }
    var items = summary.symptoms || [];
    $('#symptomTag').textContent = items.length ? items.length + ' 条' : '无';
    if (!items.length) {
      box.innerHTML = '<div class="empty">还没有记录。老人在老人端说不舒服时会自动记下来。</div>';
      return;
    }
    box.innerHTML = items.map(function (s) {
      var urg = s.severity === 'high';
      return '<div class="med-row">' +
        '<div class="med-main"><b>' + esc(s.text) + '</b>' +
          '<small>' + esc((s.at || '').slice(5, 16)) +
          (urg ? ' · <span style="color:var(--danger)">按紧急处理</span>' : ' · 已记录') + '</small></div>' +
        (s.alert_id ? '<button class="btn btn-ghost btn-sm" data-symalert="' + s.alert_id + '">看工单</button>' : '') +
      '</div>';
    }).join('');
  }

  async function loadPlan() {
    try {
      var r = await API.get('/api/meds');
      plan = r.items || [];
      renderPlan(plan);
    } catch (e) { /* 无权或失败时静默 */ }
  }

  function renderReport() {
    var rep = summary.report;
    $('#reportTag').textContent = rep.hidden ? '已隐藏' : '只呈现，不下结论';
    if (rep.hidden) {
      $('#reportBody').innerHTML =
        '<div class="empty">老人已撤回健康数据授权，血压与依从率不再展示。<br>' +
        '<span class="small">其他数据（告警、留言）仍可查看。</span></div>';
      return;
    }
    var adherence = rep.adherence == null ? '—' : rep.adherence + '%';
    var rows = [
      ['用药依从率', adherence, rep.expected ? rep.taken + ' / ' + rep.expected + ' 次' : ''],
      ['血压记录', String(rep.vital_count || 0) + ' 次', ''],
      ['告警', String(rep.alerts || 0) + ' 次（求助 ' + (rep.sos || 0) + '）', ''],
      ['已结案', String(rep.closed || 0) + ' 次', '']
    ];
    var html = '<div class="stat-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:.8rem">' +
      rows.map(function (r) {
        return '<div class="stat"><b>' + esc(r[1]) + '</b><span>' + esc(r[0]) +
          (r[2] ? ' · ' + esc(r[2]) : '') + '</span></div>';
      }).join('') + '</div>';
    html += chart(rep.vitals || []);
    html += '<p class="small muted" style="margin-top:.6rem">数据来自老人端与设备上报，仅作呈现；任何异常请直接联系老人或社区医生。</p>';
    $('#reportBody').innerHTML = html;
  }

  function chart(vitals) {
    if (!vitals.length) {
      return '<div class="empty">近 7 天还没有血压记录。</div>';
    }
    var W = 340, H = 130, padL = 28, padB = 20, padT = 10;
    var vals = vitals.map(function (v) { return { sys: v.sys, dia: v.dia, t: v.measured_at }; });
    var max = Math.max.apply(null, vals.map(function (v) { return v.sys; })) + 10;
    var min = Math.min.apply(null, vals.map(function (v) { return v.dia; })) - 10;
    function x(i) { return padL + (vals.length === 1 ? (W - padL - 8) / 2 : i * (W - padL - 8) / (vals.length - 1)); }
    function y(v) { return padT + (max - v) / (max - min) * (H - padT - padB); }
    function path(key) {
      return vals.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v[key]).toFixed(1); }).join(' ');
    }
    var last = vals[vals.length - 1];
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="近 7 天血压趋势">' +
      '<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - 8) + '" y2="' + (H - padB) + '" stroke="#E4DCCC"/>' +
      '<text x="2" y="' + (y(max) + 4) + '">' + max + '</text>' +
      '<text x="2" y="' + (y(min) + 4) + '">' + min + '</text>' +
      '<path d="' + path('sys') + '" fill="none" stroke="#A6362B" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="' + path('dia') + '" fill="none" stroke="#2C6653" stroke-width="2" stroke-linejoin="round"/>' +
      vals.map(function (v, i) {
        return '<circle cx="' + x(i) + '" cy="' + y(v.sys) + '" r="2.6" fill="#A6362B"/>' +
               '<circle cx="' + x(i) + '" cy="' + y(v.dia) + '" r="2.6" fill="#2C6653"/>';
      }).join('') +
      '</svg>' +
      '<div class="legend" style="margin-top:.4rem">' +
        '<span><i style="background:#A6362B"></i>高压 ' + last.sys + '</span>' +
        '<span><i style="background:#2C6653"></i>低压 ' + last.dia + '</span>' +
        '<span class="muted">最近一次 ' + esc(relTime(last.t)) + '</span>' +
      '</div>';
  }

  function renderThread() {
    var box = $('#thread');
    if (!messages.length) {
      box.innerHTML = '<p class="muted small">还没有留言。写一句，设备会读给老人听。</p>';
      return;
    }
    box.innerHTML = messages.slice(0, 12).map(function (m) {
      var mine = me && m.from_user === me.id;
      return '<div class="msg' + (mine ? ' mine' : '') + '">' + esc(m.text) +
        '<small>' + esc(m.from_name || '家人') + ' · ' + esc(relTime(m.created_at)) +
        (m.read_at ? ' · 已读' : '') + '</small></div>';
    }).join('');
  }

  function renderConsents() {
    $$('[data-consent]').forEach(function (input) {
      var v = summary.consents[input.dataset.consent];
      input.checked = !!v;
    });
  }

  /* ---------- 紧急联系人 ---------- */

  function renderContacts(items) {
    var box = $('#contactList');
    if (!box) { return; }
    if (!items || !items.length) {
      box.innerHTML = '<div class="empty">还没有紧急联系人<br><span class="small">' +
        '至少加一个能接电话的人，出事时系统才找得到人</span></div>';
      return;
    }
    box.innerHTML = items.map(function (c, i) {
      return '<div class="med-row" data-cid="' + c.id + '">' +
        '<div class="med-main" style="flex:1">' +
          '<b>第 ' + (i + 1) + ' 顺位 · ' + esc(c.name) +
            ' <span class="tag">' + esc(c.relation || '家属') + '</span>' +
            (c.can_call ? '' : ' <span class="tag tag-warn">仅收短信</span>') + '</b>' +
          '<small>' + esc(c.phone) + (c.note ? ' · ' + esc(c.note) : '') + '</small>' +
        '</div>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-cedit="' + c.id + '">改</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-cdel="' + c.id + '">删</button>' +
      '</div>';
    }).join('');
  }

  async function loadContacts() {
    try {
      var d = await API.get('/api/contacts');
      renderContacts(d.items || []);
    } catch (e) { /* 首页其它数据更重要 */ }
  }

  function contactFields(c) {
    c = c || {};
    return '<div class="field"><label>姓名</label>' +
        '<input data-f="name" value="' + esc(c.name || '') + '" placeholder="李梅"></div>' +
      '<div class="row"><div class="field"><label>关系</label>' +
        '<input data-f="relation" value="' + esc(c.relation || '') + '" placeholder="女儿"></div>' +
        '<div class="field"><label>手机号</label>' +
        '<input data-f="phone" type="tel" value="' + esc(c.phone || '') + '" placeholder="13800000002"></div></div>' +
      '<div class="field"><label>顺位（数字越小越先打）</label>' +
        '<input data-f="priority" type="number" min="1" max="99" value="' + esc(c.priority || '') + '" placeholder="1"></div>';
  }

  $('#addContactBtn').addEventListener('click', async function () {
    var v = await modalForm({
      title: '添加紧急联系人',
      desc: '必须是真实在用的手机号，出事时系统会直接拨过去。',
      fields: contactFields({}),
      ok: '添加'
    });
    if (!v) { return; }
    try {
      var d = await API.post('/api/contacts', v);
      renderContacts(d.items || []);
      toast('已添加', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  $('#contactList').addEventListener('click', async function (e) {
    var del = e.target.closest('[data-cdel]');
    var edit = e.target.closest('[data-cedit]');
    if (del) {
      var ok = await confirmBox({ title: '删除联系人', text: '删掉之后，求助时不会再联系这个人。', ok: '删除', danger: true });
      if (!ok) { return; }
      try {
        var d = await API.post('/api/contacts/' + del.dataset.cdel + '/delete', {});
        renderContacts(d.items || []);
        toast('已删除');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (edit) {
      var row = e.target.closest('[data-cid]');
      var items = (await API.get('/api/contacts')).items || [];
      var cur = items.filter(function (x) { return String(x.id) === edit.dataset.cedit; })[0] || {};
      var v = await modalForm({
        title: '修改联系人',
        fields: contactFields(cur),
        ok: '保存'
      });
      if (!v) { return; }
      try {
        var d2 = await API.post('/api/contacts/' + edit.dataset.cedit + '/update', v);
        renderContacts(d2.items || []);
        toast('已保存', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    }
  });

  /* ---------- 数据 ---------- */

  async function load(first) {
    try {
      summary = await API.get('/api/family/summary');
      var e = summary.elder;
      $('#eyebrow').textContent = '家属端 · ' + (me ? me.name : '') + (me && me.relation ? '（' + me.relation + '）' : '');
      var openN = summary.open_alerts.length;
      var sos = summary.open_alerts.filter(function (a) { return a.level === 'sos'; }).length;
      $('#headline').textContent = sos ? '有 ' + sos + ' 条紧急求助，正在处理。'
        : openN ? '有 ' + openN + ' 条告警待处理。'
        : e.name + '今天整体平稳。';
      var hb = summary.heartbeat || {};
      var devTxt = '';
      if (hb.last_seen) {
        devTxt = hb.alive
          ? '；设备在线'
          : '；<b style="color:var(--danger)">设备已 ' + Math.round(hb.minutes || 0) + ' 分钟没响应</b>';
      }
      $('#subline').innerHTML = (summary.med_progress.total
        ? '今天用药 ' + summary.med_progress.taken + ' / ' + summary.med_progress.total +
          '；告警与留言实时同步；健康数据是否可见由' + esc(e.display) + '授权'
        : '还没有登记用药计划') + devTxt + '。';

      notifyNewAlerts(summary.open_alerts);
      renderStats();
      renderAlerts();
      renderMeds();
      renderSymptoms();
      renderReport();
      renderConsents();
      $('#phoneTag').textContent = me ? me.phone : '';
      loadContacts();

      var msgs = await API.get('/api/messages');
      messages = msgs.items || [];
      renderThread();
      await loadPlan();
    } catch (err) {
      if (first) { toast(err.message, 'err'); }
    }
  }

  $('#symptomList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-symalert]');
    if (!b) { return; }
    toast('工单 #' + b.dataset.symalert + ' 已推给社区值守，可在告警列表里看到处理进度');
  });

  /* ---------- 桌面通知 ---------- */

  function notifySupported() {
    return typeof window.Notification !== 'undefined' && window.isSecureContext !== false;
  }

  function syncNotifyBtn() {
    var btn = $('#notifyBtn');
    if (!btn) { return; }
    if (!notifySupported()) {
      btn.hidden = true;
      return;
    }
    var p = Notification.permission;
    btn.textContent = p === 'granted' ? '通知已开' : p === 'denied' ? '通知被拒' : '开启通知';
    btn.disabled = p === 'denied';
  }

  function notifyNewAlerts(items) {
    var ids = (items || []).map(function (a) { return a.id; });
    if (knownAlerts === null) { knownAlerts = ids; return; }
    var fresh = (items || []).filter(function (a) { return knownAlerts.indexOf(a.id) < 0; });
    knownAlerts = ids;
    if (!fresh.length || !notifySupported() || Notification.permission !== 'granted') { return; }
    fresh.slice(0, 3).forEach(function (a) {
      try {
        var n = new Notification(a.level === 'sos' ? '紧急求助' : '新的告警', {
          body: (a.elder_name ? a.elder_name + '：' : '') + a.title,
          tag: 'anyu-alert-' + a.id,
          icon: '/favicon.svg',
          requireInteraction: a.level === 'sos'
        });
        n.onclick = function () { window.focus(); n.close(); };
      } catch (e) { /* 某些浏览器不支持自定义通知 */ }
    });
  }

  /* ---------- 交互 ---------- */

  $('#alertList').addEventListener('click', async function (e) {
    var noteBtn = e.target.closest('[data-note]');
    var closeBtn = e.target.closest('[data-close]');
    if (noteBtn) {
      var r = await modalForm({
        title: '补充说明', desc: '会写进工单时间线，社区也能看到。',
        fields: '<div class="field"><label for="nt">说明</label><textarea id="nt" data-f="text" placeholder="已拨打电话，老人在家，无大碍"></textarea></div>',
        ok: '提交'
      });
      if (!r || !r.text) { return; }
      try {
        await API.post('/api/alerts/' + noteBtn.dataset.note + '/note', { text: r.text });
        toast('已记录', 'ok');
        load();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (closeBtn) {
      var ok = await confirmBox({
        title: '标记为已处理？', text: '会通知社区这条工单可以结案，并保留处理记录。',
        ok: '确认已处理'
      });
      if (!ok) { return; }
      try {
        await API.post('/api/alerts/' + closeBtn.dataset.close + '/close', { note: '家属已确认安全' });
        toast('已处理', 'ok');
        load();
      } catch (err) { toast(err.message, 'err'); }
    }
  });

  $('#medList').addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-medconfirm]');
    if (!btn) { return; }
    btn.disabled = true;
    try {
      await API.post('/api/meds/' + btn.dataset.medconfirm + '/confirm');
      toast('已代为确认，操作人会记录', 'ok');
      load();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  function medForm(m) {
    return '<div class="row"><div class="field"><label>药名</label>' +
      '<input id="mName" type="text" data-f="name" value="' + esc(m ? m.name : '') + '" placeholder="苯磺酸氨氯地平片"></div>' +
      '<div class="field"><label>每次剂量</label>' +
      '<input id="mDose" type="text" data-f="dose" value="' + esc(m ? m.dose || '' : '1 片') + '" placeholder="1 片"></div></div>' +
      '<div class="row"><div class="field"><label>时间</label>' +
      '<input id="mTime" type="time" data-f="time" value="' + esc(m ? m.time_hhmm : '08:00') + '"></div>' +
      '<div class="field"><label>饭前还是饭后</label>' +
      '<input id="mMeal" type="text" data-f="meal" value="' + esc(m ? m.meal || '' : '') + '" placeholder="早饭后 / 随餐"></div></div>';
  }

  $('#addMedBtn').addEventListener('click', async function () {
    var r = await modalForm({
      title: '加一种药', desc: '按医嘱填写；助手只负责提醒，不改剂量。',
      fields: medForm(null), ok: '添加'
    });
    if (!r) { return; }
    try {
      await API.post('/api/meds', { name: r.name, dose: r.dose, time: r.time, meal: r.meal });
      toast('已加入用药计划', 'ok');
      load();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('#planList').addEventListener('click', async function (e) {
    var editBtn = e.target.closest('[data-editmed]');
    var delBtn = e.target.closest('[data-delmed]');
    if (editBtn) {
      var m = plan.filter(function (x) { return x.id === Number(editBtn.dataset.editmed); })[0];
      if (!m) { return; }
      var r = await modalForm({ title: '修改用药', fields: medForm(m), ok: '保存' });
      if (!r) { return; }
      try {
        await API.post('/api/meds/' + m.id + '/update', {
          name: r.name, dose: r.dose, time: r.time, meal: r.meal
        });
        toast('已保存', 'ok');
        load();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (delBtn) {
      var id = Number(delBtn.dataset.delmed);
      var item = plan.filter(function (x) { return x.id === id; })[0] || {};
      var ok = await confirmBox({
        title: '停用这个药？',
        text: '「' + (item.name || '') + ' ' + (item.time_hhmm || '') + '」以后不再提醒；已有记录保留。',
        ok: '停用', danger: true
      });
      if (!ok) { return; }
      try {
        await API.post('/api/meds/' + id + '/delete', {});
        toast('已停用', 'ok');
        load();
      } catch (err) { toast(err.message, 'err'); }
    }
  });

  $('#composeForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var input = $('#composeInput');
    var text = input.value.trim();
    if (!text) { return; }
    try {
      await API.post('/api/messages', { text: text });
      input.value = '';
      toast('留言已发，老人端会读出来', 'ok');
      load();
    } catch (err) { toast(err.message, 'err'); }
  });

  $$('[data-consent]').forEach(function (input) {
    input.addEventListener('change', async function () {
      var key = input.dataset.consent;
      var body = {};
      body[key] = input.checked ? 1 : 0;
      try {
        await API.post('/api/consents', body);
        toast(input.checked ? '已开放' : '已撤回，家属端立即隐藏对应数据', 'ok');
        load();
      } catch (err) {
        input.checked = !input.checked;
        toast(err.message, 'err');
      }
    });
  });

  $('#notifyBtn').addEventListener('click', async function () {
    if (!notifySupported()) { toast('这个浏览器不支持桌面通知', 'err'); return; }
    try {
      var p = await Notification.requestPermission();
      syncNotifyBtn();
      if (p === 'granted') {
        toast('已开启：有新告警会在电脑/手机弹出提醒', 'ok');
        new Notification('安语已开启通知', { body: '有新的告警或求助时，这里会提醒你。', icon: '/favicon.svg' });
      } else {
        toast('没有授权，通知不会弹出', 'err');
      }
    } catch (e) { toast('开启失败：' + e.message, 'err'); }
  });

  $('#vitalBtn').addEventListener('click', async function () {
    var r = await modalForm({
      title: '记录一次血压', desc: '由家属代记，来源会标注为家属。',
      fields:
        '<div class="row-3">' +
        '<div class="field"><label for="s">高压</label><input id="s" type="number" data-f="sys" placeholder="135"></div>' +
        '<div class="field"><label for="d">低压</label><input id="d" type="number" data-f="dia" placeholder="85"></div>' +
        '<div class="field"><label for="p">脉搏</label><input id="p" type="number" data-f="pulse" placeholder="74"></div>' +
        '</div>',
      ok: '记录'
    });
    if (!r) { return; }
    if (!r.sys || !r.dia) { toast('高压低压都要填', 'err'); return; }
    try {
      await API.post('/api/vitals', { sys: Number(r.sys), dia: Number(r.dia), pulse: r.pulse ? Number(r.pulse) : null });
      toast('已记录', 'ok');
      load();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('#infoBtn').addEventListener('click', function () {
    var p = summary.profile || {};
    var e = summary.elder;
    var html =
      '<dl class="kv">' +
      '<div><dt>姓名</dt><dd>' + esc(e.name) + '（' + esc(e.age || '—') + ' 岁）</dd></div>' +
      '<div><dt>血型</dt><dd>' + esc(p.blood_type || '—') + '</dd></div>' +
      '<div><dt>基础病</dt><dd>' + esc(p.conditions || '—') + '</dd></div>' +
      '<div><dt>过敏</dt><dd>' + esc(p.allergies || '—') + '</dd></div>' +
      '<div style="grid-column:1/-1"><dt>住址</dt><dd>' + esc(p.address || '—') + '</dd></div>' +
      '<div style="grid-column:1/-1"><dt>所属社区</dt><dd>' + esc(p.community || '—') + '</dd></div>' +
      '</dl>';
    confirmBox({ title: '应急信息卡', html: html, ok: '知道了', cancel: '关闭' });
  });

  $('#pwdForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var oldP = $('#oldPwd').value;
    var newP = $('#newPwd').value;
    if (newP.length < 6) { toast('新密码至少 6 位', 'err'); return; }
    try {
      await API.post('/api/auth/password', { old: oldP, new: newP });
      toast('密码已更新', 'ok');
      $('#oldPwd').value = ''; $('#newPwd').value = '';
    } catch (err) { toast(err.message, 'err'); }
  });

  /* ---------- 启动 ---------- */

  (async function init() {
    applyA11y();
    try {
      var r = await API.get('/api/me');
      me = r.user;
      bindTopbar(me);
    } catch (e) { return; }
    syncNotifyBtn();
    await load(true);
    setInterval(function () { load(false); }, 6000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { load(false); } });
  })();
})();
