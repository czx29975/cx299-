/* 社区端：工单状态机、名册、指标、账号与大模型设置 */
(function () {
  'use strict';

  var me = null;
  var tab = 'pending';
  var orders = [];
  var detailId = null;
  var roster = [];
  var metrics = null;
  var tickTimer = null;

  /* ---------- 工具 ---------- */

  function parseTs(iso) {
    if (!iso) { return 0; }
    return new Date(String(iso).replace(' ', 'T')).getTime();
  }

  function nowStr() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function slaOf(a) {
    var base = a.level === 'sos' ? 60000 : 300000;
    if (a.status === 'closed') { return { text: '已结案', cls: '' }; }
    if (a.status === 'accepted' || a.status === 'arrived') {
      return { text: '已接单 · ' + relTime(a.accepted_at), cls: '' };
    }
    var left = base - (Date.now() - parseTs(a.raised_at));
    if (left >= 0) {
      var s = Math.ceil(left / 1000);
      return { text: '响应剩 ' + (s >= 60 ? Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒' : s + ' 秒'), cls: '' };
    }
    var o = Math.floor(-left / 1000);
    return { text: '已超时 ' + (o >= 60 ? Math.floor(o / 60) + ' 分' : o + ' 秒'), cls: 'over' };
  }

  function statusLabel(s) {
    return { pending: '待接单', accepted: '处理中', arrived: '已到场', closed: '已闭环' }[s] || s;
  }

  function modal(html) {
    var back = document.createElement('div');
    back.className = 'backdrop';
    back.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
    back.addEventListener('click', function (e) {
      if (e.target === back || e.target.hasAttribute('data-no')) { back.remove(); }
    });
    document.body.appendChild(back);
    return back;
  }

  /* ---------- 渲染 ---------- */

  function renderStats() {
    var pending = orders.filter(function (a) { return a.status === 'pending'; }).length;
    if (tab !== 'pending') { pending = Number($('#nPending').textContent) || 0; }
    var doing = orders.filter(function (a) { return a.status === 'accepted' || a.status === 'arrived'; }).length;
    if (tab !== 'doing') { doing = Number($('#nDoing').textContent) || 0; }
    var sos = orders.filter(function (a) { return a.level === 'sos' && a.status !== 'closed'; }).length;
    var stats = [
      { v: String(pending), s: '待接单', cls: pending ? 'alert' : 'ok' },
      { v: String(doing), s: '处理中', cls: '' },
      { v: metrics ? String(metrics.alerts_7d) : '—', s: '近 7 天工单', cls: '' },
      { v: metrics && metrics.avg_response_sec != null ? metrics.avg_response_sec + ' 秒' : '—', s: '接单中位耗时', cls: 'ok' }
    ];
    $('#stats').innerHTML = stats.map(function (s) {
      return '<div class="stat ' + s.cls + '"><b>' + esc(s.v) + '</b><span>' + esc(s.s) + '</span></div>';
    }).join('');
    $('#headline').textContent = sos ? '有 ' + sos + ' 条紧急求助在处理。'
      : pending ? '有 ' + pending + ' 条工单等着接。' : '目前没有待接工单。';
  }

  function renderList() {
    var box = $('#orderList');
    if (!orders.length) {
      box.innerHTML = '<div class="empty">这一类没有工单。切到「待接单」看看，或让老人在老人端按一次求助。</div>';
      return;
    }
    box.innerHTML = orders.map(function (a) {
      var sla = slaOf(a);
      return '<button class="order' + (a.level === 'sos' ? ' sos' : '') + (a.id === detailId ? ' on' : '') + '" data-id="' + a.id + '">' +
        '<span class="dot"></span>' +
        '<span><b>' + esc(a.title) + '</b>' +
          '<small>' + esc(a.elder_name || '') + ' · ' + esc(relTime(a.raised_at)) +
          (a.assignee_name ? ' · ' + esc(a.assignee_name) : '') + '</small></span>' +
        '<span class="right"><span class="tag ' + (a.level === 'sos' ? 'tag-danger' : a.level === 'warn' ? 'tag-warn' : '') + '">' +
          esc(statusLabel(a.status)) + '</span><span class="sla ' + sla.cls + '" data-sla="' + a.id + '">' + esc(sla.text) + '</span></span>' +
      '</button>';
    }).join('');
  }

  function renderRoster() {
    $('#rosterTag').textContent = roster.length + ' 位在册';
    $('#rosterBody').innerHTML = roster.map(function (e) {
      var off = (e.device_status || 'online') !== 'online';
      return '<tr>' +
        '<td><b>' + esc(e.name) + '</b> <span class="small muted">' + esc(e.age || '') + '</span></td>' +
        '<td class="small">' + esc(e.address || '—') + '</td>' +
        '<td class="small">' + esc(e.conditions || '—') + '</td>' +
        '<td><span class="tag ' + (off ? 'tag-danger' : 'tag-ok') + '">' + (off ? '离线' : '在线') + '</span></td>' +
        '<td>' + esc(e.meds) + '</td>' +
        '<td>' + (e.open_alerts ? '<span class="tag tag-danger">' + e.open_alerts + '</span>' : '<span class="muted small">0</span>') + '</td>' +
        '<td class="small">' + esc(e.last_event || '—') + (e.last_at ? ' <span class="muted">' + esc(relTime(e.last_at)) + '</span>' : '') + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="7" class="muted">还没有老人档案</td></tr>';
  }

  function renderMetrics() {
    if (!metrics) { return; }
    var names = { sos: '紧急求助', voice: '语音主诉', med: '用药超时', device: '设备告警',
      symptom: '身体不适', inactive: '长时间没动静', system: '系统', other: '其他' };
    var total = Math.max(1, metrics.alerts_7d);
    var entries = Object.keys(metrics.by_source || {}).map(function (k) {
      return { k: names[k] || k, n: metrics.by_source[k] };
    }).sort(function (a, b) { return b.n - a.n; });
    if (!entries.length) { entries = [{ k: '暂无工单', n: 0 }]; }
    $('#barSource').innerHTML = entries.map(function (e) {
      return '<li><span class="small">' + esc(e.k) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + Math.round(e.n / total * 100) + '%"></span></span>' +
        '<span class="val">' + e.n + '</span></li>';
    }).join('');
    $('#mAvg').textContent = metrics.avg_response_sec != null ? metrics.avg_response_sec + ' 秒' : '—';
    $('#mCount').textContent = String(metrics.alerts_7d);
    $('#mRate').textContent = metrics.online_rate != null ? metrics.online_rate + '%' : '—';
    $('#mElders').textContent = String(metrics.elders);
  }

  /* ---------- 详情 ---------- */

  async function openDetail(id) {
    detailId = id;
    renderList();
    try {
      var r = await API.get('/api/alerts/' + id);
      var a = r.alert;
      var e = a.elder || {};
      $('#detailTag').textContent = statusLabel(a.status);
      var actions = '';
      if (a.status === 'pending') {
        actions = '<button class="btn btn-primary btn-sm" data-act="accept">接单</button>' +
                  '<button class="btn btn-ghost btn-sm" data-act="close">直接结案</button>';
      } else if (a.status === 'accepted' || a.status === 'arrived') {
        actions = (a.status === 'accepted' ? '<button class="btn btn-primary btn-sm" data-act="arrive">标记到场</button>' : '') +
                  '<button class="btn btn-ghost btn-sm" data-act="close">结案</button>';
      } else if (a.status === 'closed') {
        actions = '<button class="btn btn-ghost btn-sm" data-act="reopen">重新打开</button>';
      }
      var calls = a.calls || [];
      var stageTxt = a.level !== 'sos' ? '非紧急工单，不触发外呼'
        : (a.call_stage ? '已升到第 ' + a.call_stage + ' 级' : '等待接单，60 秒后开始外呼');
      var callsHtml = calls.length
        ? calls.map(function (c) {
            return '<div class="call-row"><b>第 ' + (c.stage || 0) + ' 级</b>' +
              '<span>' + esc(c.name || '') + ' ' + esc((c.phone || '').slice(-4)) + '</span>' +
              '<span class="st ' + (c.ok ? 'ok' : 'no') + '">' + (c.ok ? '已拨出' : '失败') + '</span>' +
              '<span class="muted" style="margin-left:auto">' + esc((c.created_at || '').slice(5, 16)) + '</span></div>';
          }).join('')
        : '<p class="small muted">还没有拨出电话</p>';

      $('#detailBody').innerHTML =
        '<h3 style="font-size:1.05rem;margin-bottom:.2rem">' + esc(a.title) + '</h3>' +
        '<p class="small muted">' + esc(e.name || '') + ' · ' + esc(a.raised_at) +
          (a.assignee_name ? ' · 责任人 ' + esc(a.assignee_name) : '') + '</p>' +
        (a.detail ? '<p style="font-size:.9rem;color:var(--ink-2);margin:.5rem 0">' + esc(a.detail) + '</p>' : '') +
        '<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:.7rem 0">' + actions +
          '<button class="btn btn-ghost btn-sm" data-act="note">补充说明</button></div>' +
        '<p class="small muted" style="margin:.6rem 0 .3rem">应急信息</p>' +
        '<dl class="kv">' +
          '<div><dt>年龄</dt><dd>' + esc(e.age || '—') + '</dd></div>' +
          '<div><dt>设备</dt><dd>' + esc(e.device_status === 'online' ? '在线' : '离线') + '</dd></div>' +
          '<div style="grid-column:1/-1"><dt>住址</dt><dd>' + esc(e.address || '—') + '</dd></div>' +
        '</dl>' +
        '<p class="small muted" style="margin:.9rem 0 .3rem">逐级外呼 · ' + esc(stageTxt) + '</p>' +
        '<div>' + callsHtml + '</div>' +
        '<p class="small muted" style="margin:.9rem 0 .3rem">事件时间线</p>' +
        '<ul class="timeline">' + (a.events || []).map(function (ev) {
          return '<li><i></i><span><b>' + esc(ev.text) + '</b><small>' + esc(ev.actor || '') + ' · ' + esc(ev.at) + '</small></span></li>';
        }).join('') + '</ul>';
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* ---------- 动作 ---------- */

  async function doAction(act) {
    if (!detailId) { return; }
    try {
      if (act === 'note') {
        var back = modal(
          '<h2>补充说明</h2><p class="small muted" style="margin-bottom:.7rem">写进时间线，家属端也能看到。</p>' +
          '<div class="field"><textarea id="noteText" placeholder="已电话联系，老人在家，情绪稳定"></textarea></div>' +
          '<div class="modal-actions"><button class="btn btn-ghost" data-no>取消</button>' +
          '<button class="btn btn-primary" id="noteOk">提交</button></div>');
        back.querySelector('#noteOk').addEventListener('click', async function () {
          var text = back.querySelector('#noteText').value.trim();
          if (!text) { toast('写点什么再提交', 'err'); return; }
          try {
            await API.post('/api/alerts/' + detailId + '/note', { text: text });
            back.remove();
            toast('已记录', 'ok');
            openDetail(detailId);
          } catch (err) { toast(err.message, 'err'); }
        });
        return;
      }
      if (act === 'close') {
        var ok = await confirmBox({ title: '确认结案？', text: '结案后工单进入已闭环，事件记录保留。', ok: '确认结案' });
        if (!ok) { return; }
        await API.post('/api/alerts/' + detailId + '/close', { note: '已确认安全' });
      } else {
        await API.post('/api/alerts/' + detailId + '/' + act, {});
      }
      toast('已更新', 'ok');
      await loadBoard();
      await openDetail(detailId);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* ---------- 数据 ---------- */

  async function loadBoard() {
    var status = tab === 'pending' ? 'open' : tab === 'closed' ? 'closed' : null;
    try {
      var all = await API.get('/api/console/board');
      var items = all.items || [];
      var pending = items.filter(function (a) { return a.status === 'pending'; }).length;
      var doing = items.filter(function (a) { return a.status === 'accepted' || a.status === 'arrived'; }).length;
      var closed = items.filter(function (a) { return a.status === 'closed'; }).length;
      $('#nPending').textContent = pending;
      $('#nDoing').textContent = doing;
      $('#nClosed').textContent = closed;
      watchSos(items);
      orders = items.filter(function (a) {
        if (tab === 'pending') { return a.status === 'pending'; }
        if (tab === 'doing') { return a.status === 'accepted' || a.status === 'arrived'; }
        return a.status === 'closed';
      });
      renderList();
      renderStats();
      if (detailId && !items.some(function (a) { return a.id === detailId; })) {
        detailId = null;
        $('#detailBody').innerHTML = '<div class="empty">这条工单已不在列表中</div>';
        $('#detailTag').textContent = '未选择';
      }
    } catch (err) {
      $('#liveTag').textContent = '连接中断';
      $('#liveTag').className = 'tag tag-danger';
    }
  }

  async function loadRoster() {
    try {
      var r = await API.get('/api/console/roster');
      roster = r.items || [];
      renderRoster();
    } catch (e) {}
  }

  async function loadMetrics() {
    try {
      metrics = await API.get('/api/console/metrics');
      renderMetrics();
      renderStats();
    } catch (e) {}
  }

  async function loadAll() {
    await Promise.all([loadBoard(), loadRoster(), loadMetrics()]);
    $('#liveTag').textContent = '实时';
    $('#liveTag').className = 'tag tag-ok';
  }

  /* ---------- 弹层：账号 / 大模型 / 新增老人 ---------- */

  async function openUsers() {
    var users = [];
    var elders = [];
    var codes = [];
    try { var r = await API.get('/api/console/users'); users = r.items || []; } catch (e) {}
    try { var r2 = await API.get('/api/console/elders'); elders = r2.items || []; } catch (e) {}
    try { var r3 = await API.get('/api/console/bindcode'); codes = r3.items || []; } catch (e) {}
    var rows = users.map(function (u) {
      var role = { elder: '老人', family: '家属', community: '社区', admin: '管理' }[u.role] || u.role;
      var ptag = u.phone_ok ? '' : ' <span class="tag tag-danger" title="' +
        esc(u.phone_note || '号段不合法') + '">号码无效</span>';
      return '<tr><td>' + esc(u.name) + '</td><td>' + esc(role) + '</td><td>' + esc(u.phone) + ptag +
        '</td><td>' + esc(u.elder_name || '—') + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" data-reset="' + esc(u.phone) + '">重置密码</button></td></tr>';
    }).join('');

    function codeOf(eid) {
      var hit = codes.filter(function (c) {
        return c.elder_id === eid && !c.used_at && c.expires_at > nowStr();
      })[0];
      return hit || null;
    }
    function bindRows() {
      return elders.map(function (e) {
        var c = codeOf(e.id);
        return '<tr><td>' + esc(e.name) + '</td>' +
          '<td>' + (c ? '<b style="letter-spacing:.15em">' + esc(c.code) + '</b>' : '<span class="muted small">未生成</span>') + '</td>' +
          '<td class="small muted">' + (c ? esc((c.expires_at || '').slice(5, 16)) : '—') + '</td>' +
          '<td>' + (c ? '<span class="tag tag-ok">可用</span>' : '<span class="tag">无</span>') + '</td>' +
          '<td><button class="btn btn-ghost btn-sm" data-gencode="' + e.id + '">' +
            (c ? '换一个' : '生成') + '</button></td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted small">还没有老人档案</td></tr>';
    }

    var back = modal(
      '<h2>账号管理</h2>' +
      '<p class="small muted" style="margin-bottom:.7rem">三个角色都用手机号登录；新账号创建后把密码告诉本人即可。</p>' +
      '<div class="table-wrap" style="max-height:16rem;overflow:auto"><table class="data">' +
        '<thead><tr><th>姓名</th><th>角色</th><th>手机号</th><th>对应老人</th><th></th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="5" class="muted">暂无账号</td></tr>') + '</tbody></table></div>' +
      '<p class="small muted" style="margin:1rem 0 .4rem">家属绑定码</p>' +
      '<p class="small muted" style="margin-bottom:.5rem">家属自助注册时要填这个码才能绑定到对应老人，' +
        '一个码只能用一次，默认 72 小时有效。</p>' +
      '<div class="table-wrap" style="max-height:12rem;overflow:auto"><table class="data">' +
        '<thead><tr><th>老人</th><th>绑定码</th><th>有效期</th><th>状态</th><th></th></tr></thead>' +
        '<tbody id="bindBody">' + bindRows() + '</tbody></table></div>' +
      '<p class="small muted" style="margin:1rem 0 .4rem">新增账号</p>' +
      '<form id="addUserForm">' +
        '<div class="row"><div class="field"><label>姓名</label><input id="uName" type="text"></div>' +
        '<div class="field"><label>角色</label><select id="uRole"><option value="family">家属</option><option value="elder">老人</option><option value="community">社区</option></select></div></div>' +
        '<div class="row"><div class="field"><label>手机号</label><input id="uPhone" type="tel" inputmode="numeric"></div>' +
        '<div class="field"><label>初始密码</label><input id="uPwd" type="password" placeholder="至少 6 位"></div></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" type="button" data-no>关闭</button>' +
        '<button class="btn btn-primary" type="submit">创建账号</button></div>' +
      '</form>');
    back.addEventListener('click', async function (e) {
      var gen = e.target.closest('[data-gencode]');
      if (gen) {
        try {
          var g = await API.post('/api/console/bindcode', { elder_id: Number(gen.dataset.gencode), hours: 72 });
          toast('绑定码 ' + g.code + '，72 小时内有效', 'ok');
          var fresh = await API.get('/api/console/bindcode');
          codes = fresh.items || [];
          back.querySelector('#bindBody').innerHTML = bindRows();
        } catch (err) { toast(err.message, 'err'); }
        return;
      }
      var b = e.target.closest('[data-reset]');
      if (!b) { return; }
      var pwd = window.prompt('给 ' + b.dataset.reset + ' 设置新密码（至少 6 位）');
      if (!pwd) { return; }
      try {
        await API.post('/api/users/reset', { phone: b.dataset.reset, password: pwd });
        toast('密码已重置', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });
    back.querySelector('#addUserForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        await API.post('/api/users', {
          name: back.querySelector('#uName').value.trim(),
          role: back.querySelector('#uRole').value,
          phone: back.querySelector('#uPhone').value.trim(),
          password: back.querySelector('#uPwd').value,
          elder_id: roster[0] ? roster[0].id : null
        });
        toast('账号已创建', 'ok');
        back.remove();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  var PRESETS = {
    deepseek: { label: 'DeepSeek（推荐）', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    qwen: { label: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    zhipu: { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    custom: { label: '自定义接口', base: '', model: '' }
  };

  async function openLlm() {
    var st = { configured: false, model: '', base_url: '', key_hint: '', last_error: null };
    try { st = await API.get('/api/llm/status'); } catch (e) {}
    var errHtml = '';
    if (st.last_error && st.last_error.message) {
      errHtml = '<p class="small" style="color:var(--danger);margin:.2rem 0 .6rem">上次失败：' +
        esc(st.last_error.message) + '</p>';
    }
    var opts = Object.keys(PRESETS).map(function (k) {
      return '<option value="' + k + '">' + esc(PRESETS[k].label) + '</option>';
    }).join('');

    var back = modal(
      '<h2>接入大模型</h2>' +
      '<p class="small muted" style="margin-bottom:.7rem">填任意 OpenAI 兼容接口即可。Key 只保存在本机数据库，前端只显示掩码。</p>' +
      '<p class="small" style="margin-bottom:.5rem">当前状态：' +
        (st.configured ? '<span class="tag tag-ok">已接入 · ' + esc(st.model) + '</span>'
                       : '<span class="tag tag-warn">未接入，正在使用内置语音指令</span>') +
        (st.key_hint ? ' <span class="muted">' + esc(st.key_hint) + '</span>' : '') + '</p>' + errHtml +
      '<form id="llmForm">' +
        '<div class="field"><label for="lPreset">服务商</label><select id="lPreset">' + opts + '</select></div>' +
        '<div class="field"><label for="lBase">接口地址</label><input id="lBase" type="text" value="' +
          esc(st.base_url || PRESETS.deepseek.base) + '"></div>' +
        '<div class="field"><label for="lModel">模型名</label><input id="lModel" type="text" value="' +
          esc(st.model || PRESETS.deepseek.model) + '"></div>' +
        '<div class="field"><label for="lKey">API Key</label>' +
          '<input id="lKey" type="password" placeholder="' + (st.configured ? '已保存，留空则不修改' : 'sk-...') + '">' +
          '<span class="hint">在 platform.deepseek.com → API keys 里创建</span></div>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" type="button" data-no>关闭</button>' +
          '<button class="btn btn-ghost" type="button" id="clearLlm">清除</button>' +
          '<button class="btn btn-ghost" type="button" id="testLlm">测试</button>' +
          '<button class="btn btn-primary" type="submit">保存</button>' +
        '</div>' +
      '</form>' +
      '<p class="small muted" id="llmMsg" style="margin-top:.7rem;min-height:1.2rem"></p>');

    // 选服务商自动填地址与模型
    back.querySelector('#lPreset').addEventListener('change', function (e) {
      var p = PRESETS[e.target.value];
      if (!p || !p.base) { return; }
      back.querySelector('#lBase').value = p.base;
      back.querySelector('#lModel').value = p.model;
    });

    function payload() {
      var body = {
        base_url: back.querySelector('#lBase').value.trim(),
        model: back.querySelector('#lModel').value.trim()
      };
      var key = back.querySelector('#lKey').value.trim();
      if (key) { body.api_key = key; }
      return body;
    }

    back.querySelector('#llmForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var msg = back.querySelector('#llmMsg');
      try {
        var r = await API.post('/api/llm/config', payload());
        msg.style.color = 'var(--primary)';
        msg.textContent = r.status.configured ? '已保存，老人端对话将走大模型。' : '已保存，但还缺 Key。';
        toast(r.status.configured ? '已接入大模型' : '已保存', r.status.configured ? 'ok' : 'err');
      } catch (err) {
        msg.style.color = 'var(--danger)';
        msg.textContent = err.message;
      }
    });

    back.querySelector('#testLlm').addEventListener('click', async function () {
      var btn = back.querySelector('#testLlm');
      var msg = back.querySelector('#llmMsg');
      btn.disabled = true;
      btn.textContent = '测试中…';
      msg.style.color = 'var(--ink-3)';
      msg.textContent = '正在调用模型…';
      try {
        await API.post('/api/llm/config', payload());
        var r = await API.post('/api/llm/test', {});
        msg.style.color = 'var(--primary)';
        msg.textContent = '调用成功：' + r.model + ' · ' + r.latency_ms + ' ms · 回话「' + (r.reply || '') + '」';
        toast('Key 可用，用时 ' + r.latency_ms + ' ms', 'ok');
      } catch (err) {
        msg.style.color = 'var(--danger)';
        msg.textContent = err.message;
        toast('测试失败', 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = '测试';
      }
    });

    back.querySelector('#clearLlm').addEventListener('click', async function () {
      var ok = await confirmBox({ title: '清除大模型配置？', text: '清除后对话会退回内置语音指令。', ok: '清除' });
      if (!ok) { return; }
      try {
        await API.post('/api/llm/clear', {});
        toast('已清除');
        back.remove();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  /* ---------- 紧急求助：声光报警 ---------- */

  var knownSos = null;
  var mutedIds = [];          // 已点静音的工单；出现新工单会自动解除
  var audioCtx = null;        // 浏览器要求先有用户手势才能出声，这里统一管理
  var bannerEl = null;
  var titleTimer = null;
  var baseTitle = document.title;

  var alarmCfg = prefs.get('sosAlarm', { on: true, vol: 0.9, voice: true, repeat: true });

  /* 浏览器自动播放策略：AudioContext 在用户点过页面之前是 suspended 的，
     这时调 resume() 不会出声。所以做一个"解锁"动作，并在界面上如实显示状态。 */
  function audioState() {
    if (!audioCtx) { return 'idle'; }
    return audioCtx.state;               // running / suspended / closed
  }

  function ensureCtx() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { return null; }
    if (!audioCtx) {
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    return audioCtx;
  }

  function unlockAudio() {
    var ctx = ensureCtx();
    if (!ctx) { return Promise.resolve(false); }
    var p = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    return Promise.resolve(p).then(function () {
      syncAlarmBtn();
      return ctx.state === 'running';
    }).catch(function () { return false; });
  }

  function syncAlarmBtn() {
    var btn = $('#alarmBtn');
    if (!btn) { return; }
    var running = audioState() === 'running';
    btn.dataset.state = running ? 'on' : 'off';
    var txt = $('#alarmBtnText');
    if (txt) { txt.textContent = running ? '警报已开' : '开启警报'; }
    btn.title = running
      ? '声音警报已开启：有紧急求助时会持续鸣响'
      : '声音警报未开启：点一下解锁浏览器声音（点过任意位置即可）';
  }

  /* 一次鸣响：三个急促的上扬音，像消防警报而不是"叮"一声 */
  function beepOnce() {
    var ctx = ensureCtx();
    if (!ctx || ctx.state !== 'running') { return false; }
    var vol = Math.max(0.05, Math.min(1, Number(alarmCfg.vol) || 0.9));
    try {
      var t0 = ctx.currentTime;
      for (var i = 0; i < 3; i++) {
        var t = t0 + i * 0.28;
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(720, t);
        o.frequency.linearRampToValueAtTime(1120, t + 0.12);
        o.frequency.linearRampToValueAtTime(780, t + 0.22);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
        g.gain.setValueAtTime(vol, t + 0.2);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.28);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function announce(a) {
    if (!alarmCfg.voice) { return; }
    var e = (a && a.elder_name) || '';
    var what = (a && a.title ? a.title : '').replace(/^紧急求助[：:]/, '').slice(0, 16);
    try { speak('紧急求助。' + (e ? e + '，' : '') + (what || '有人需要帮助')); } catch (err) {}
  }

  function startTitleFlash(a) {
    if (titleTimer) { return; }
    var msg = '紧急求助';
    titleTimer = setInterval(function () {
      document.title = document.title === msg ? baseTitle : msg;
    }, 800);
  }

  function stopTitleFlash() {
    if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    document.title = baseTitle;
  }

  var limitTimer = null;
  var blockedTimer = null;
  var voiceTimer = null;
  var alarmNode = null;
  var MAX_RING_MS = 10 * 60 * 1000;   // 一直没人处理时最多连响 10 分钟

  function alarmVol() {
    return Math.max(0.05, Math.min(1, Number(alarmCfg.vol) || 0.9));
  }

  /* 把警报声预先合成成一段 2.4 秒的循环音频：用 AudioBufferSourceNode 循环播放，
     不依赖 setInterval——标签页切到后台时定时器会被浏览器降频，铃声就会断断续续。 */
  function sirenBuffer(ctx) {
    var sr = ctx.sampleRate;
    var dur = 2.4;
    var n = Math.floor(sr * dur);
    var buf = ctx.createBuffer(1, n, sr);
    var d = buf.getChannelData(0);
    [0, 0.28, 0.56].forEach(function (off) {
      var L = 0.24;
      var start = Math.floor(off * sr);
      var len = Math.floor(L * sr);
      for (var i = 0; i < len; i++) {
        var t = i / sr;
        var env = Math.min(1, t / 0.02) * Math.min(1, (L - t) / 0.05);
        var f = 720 + 400 * (t / L);
        d[start + i] += Math.sin(2 * Math.PI * f * t) * 0.5 * env;
      }
    });
    return buf;
  }

  function startSound(a) {
    if (!alarmCfg.on) { return; }
    var ctx = ensureCtx();
    if (!ctx || ctx.state !== 'running') {
      markBannerBlocked();
      if (!blockedTimer) {
        blockedTimer = setTimeout(function () { blockedTimer = null; startSound(a); }, 3000);
      }
      return;
    }
    if (!alarmNode) {
      try {
        var src = ctx.createBufferSource();
        src.buffer = sirenBuffer(ctx);
        src.loop = true;
        var g = ctx.createGain();
        g.gain.value = alarmVol();
        src.connect(g);
        g.connect(ctx.destination);
        src.start();
        alarmNode = { src: src, gain: g };
        syncAlarmBtn();
      } catch (e) {
        markBannerBlocked();
        return;
      }
    }
    if (alarmCfg.voice && !voiceTimer) {
      announce(a);
      voiceTimer = setInterval(function () { announce(a); }, 6000);
    }
    syncBannerSound();
    if (alarmCfg.repeat) {
      startTitleFlash(a);
      // 一直没人处理时也别无限吵：响满 10 分钟先静音，横幅留着；新求助会重新响
      if (!limitTimer) {
        limitTimer = setTimeout(function () {
          limitTimer = null;
          mutedIds = mutedIds.concat(currentSosIds());
          stopSound();
          var hint = bannerEl && bannerEl.querySelector('[data-hint]');
          if (hint) {
            hint.hidden = false;
            hint.textContent = '已连续鸣响 10 分钟，暂时静音；有新求助会重新响';
          }
        }, MAX_RING_MS);
      }
    } else if (!limitTimer) {
      limitTimer = setTimeout(function () { limitTimer = null; stopSound(); }, 30000);
    }
  }

  function stopSound() {
    if (alarmNode) {
      try { alarmNode.src.stop(); } catch (e) {}
      try { alarmNode.src.disconnect(); } catch (e) {}
      try { alarmNode.gain.disconnect(); } catch (e) {}
      alarmNode = null;
    }
    if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; }
    if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
    if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null; }
    stopTitleFlash();
  }

  function syncSosHeight() {
    if (!bannerEl) { return; }
    document.documentElement.style.setProperty('--sos-h', bannerEl.offsetHeight + 'px');
  }
  window.addEventListener('resize', syncSosHeight);

  function markBannerBlocked() {
    if (!bannerEl) { return; }
    var hint = bannerEl.querySelector('[data-hint]');
    if (hint) {
      hint.hidden = false;
      hint.textContent = '浏览器拦住了自动播放，点「开启声音」才会响';
      syncSosHeight();
    }
  }

  /* 声音已经在响时，就别再显示「开启声音」了 */
  function syncBannerSound() {
    if (!bannerEl) { return; }
    var b = bannerEl.querySelector('[data-sound]');
    if (b) { b.hidden = audioState() === 'running'; }
    syncSosHeight();
  }

  function showBanner(a) {
    if (bannerEl) { return; }
    bannerEl = document.createElement('div');
    bannerEl.className = 'sos-banner flash';
    bannerEl.setAttribute('role', 'alert');
    var ttl = (a.title || '').replace(/^紧急求助[：:]/, '');
    var aiOnly = a.status !== 'pending';
    bannerEl.innerHTML =
      '<span class="t">紧急求助 · #' + a.id + ' ' + esc(ttl.slice(0, 30)) +
        (aiOnly ? ' <span class="alarm-hint">AI 已接单，仍等真人确认</span>' : '') + '</span>' +
      '<span class="small alarm-hint" data-hint hidden></span>' +
      '<button class="btn btn-sm" type="button" data-sound hidden>开启声音</button>' +
      '<button class="btn btn-sm" type="button" data-goto>去处理</button>' +
      '<button class="btn btn-sm" type="button" data-mute>静音</button>';
    document.body.appendChild(bannerEl);
    document.body.classList.add('has-sos');
    document.documentElement.style.setProperty('--sos-h', bannerEl.offsetHeight + 'px');

    var soundBtn = bannerEl.querySelector('[data-sound]');
    if (audioState() !== 'running') { soundBtn.hidden = false; }
    soundBtn.addEventListener('click', async function () {
      var ok = await unlockAudio();
      soundBtn.hidden = ok;
      var hint = bannerEl.querySelector('[data-hint]');
      if (hint) { hint.hidden = true; }
      if (ok) { startSound(a); }
      else { toast('还是没能出声：检查系统音量，或点一下页面任意位置再试', 'err'); }
    });
    bannerEl.querySelector('[data-goto]').addEventListener('click', function () {
      setTab(a.status === 'pending' ? 'pending' : 'doing');
      openDetail(a.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    bannerEl.querySelector('[data-mute]').addEventListener('click', function () {
      mutedIds = mutedIds.concat(currentSosIds());
      stopSound();
      bannerEl.classList.remove('flash');
      toast('已静音，横幅保留；再来新的求助会重新响');
    });
  }

  function currentSosIds() {
    return (lastSosItems || []).map(function (a) { return a.id; });
  }

  var lastSosItems = null;

  function stopAlarm() {
    stopSound();
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
    document.body.classList.remove('has-sos');
    document.documentElement.style.removeProperty('--sos-h');
  }

  /* 这条求助是否还需要真人介入：AI 值守接单不算"有人管了"，
     否则 AI 一接单铃声就断，值守员根本不知道出过事。 */
  function needsHuman(a) {
    if (a.status === 'closed') { return false; }
    var owner = (a.assignee_name || '').trim();
    return !owner || owner === 'AI 值守';
  }

  /* 只要有还没被真人接手的 SOS 就响；真人接单或闭环就停，避免一直吵 */
  function watchSos(items) {
    var sos = (items || []).filter(function (a) { return a.level === 'sos'; });
    var pending = sos.filter(needsHuman);
    lastSosItems = sos;

    var ids = sos.map(function (a) { return a.id; });
    if (knownSos === null) { knownSos = ids; } else {
      var fresh = sos.filter(function (a) { return knownSos.indexOf(a.id) < 0; });
      knownSos = ids;
      if (fresh.length && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        fresh.slice(0, 2).forEach(function (a) {
          try {
            new Notification('紧急求助', { body: a.title, tag: 'sos-' + a.id, requireInteraction: true });
          } catch (e) {}
        });
      }
    }

    if (!pending.length) { mutedIds = []; stopAlarm(); return; }

    // 新的求助不继承之前的静音
    mutedIds = mutedIds.filter(function (id) { return ids.indexOf(id) >= 0; });
    var active = pending.filter(function (a) { return mutedIds.indexOf(a.id) < 0; });
    if (!active.length) { stopSound(); return; }

    showBanner(active[0]);
    if (alarmCfg.on) { startSound(active[0]); } else { stopSound(); }
  }

  /* ---------- 警报设置 ---------- */

  function openAlarm() {
    var running = audioState() === 'running';
    var back = modal(
      '<h2>紧急报警响铃</h2>' +
      '<p class="small muted" style="margin:.3rem 0 .7rem">有人按求助或喊救命时，值守台会持续鸣响警报并语音播报是谁、什么事，' +
        '直到点「静音」或有人接单。关闭本页就听不到了，建议值守机长期开着这个页面。</p>' +

      '<div class="notice ' + (running ? '' : 'notice-warn') + '" id="alarmState">' +
        '<b id="alarmStateTitle">' + (running ? '声音已就绪' : '声音还没打开') + '</b>' +
        '<div class="small" id="alarmStateDesc">' + (running
          ? '浏览器已允许本页发声，有求助会立刻响。'
          : '浏览器要求先点一下页面才能出声。点下面的「开启并试听」，听到警报音就说明通了。') +
        '</div></div>' +

      '<button class="btn btn-primary btn-block" type="button" id="alarmUnlock">开启并试听</button>' +

      '<label class="switch-row" style="margin-top:.9rem"><span class="txt">声音报警' +
        '<small>关掉后只显示红色横幅，不再响铃</small></span>' +
        '<span class="switch"><input type="checkbox" id="alarmOn"' + (alarmCfg.on ? ' checked' : '') + '><i></i></span></label>' +

      '<label class="switch-row"><span class="txt">语音播报' +
        '<small>每响 3 轮读一次「紧急求助，王秀兰，摔倒了」</small></span>' +
        '<span class="switch"><input type="checkbox" id="alarmVoice"' + (alarmCfg.voice ? ' checked' : '') + '><i></i></span></label>' +

      '<label class="switch-row"><span class="txt">一直响到有人处理' +
        '<small>关掉则只响 30 秒；开启会配合标题闪烁，直到接单或静音</small></span>' +
        '<span class="switch"><input type="checkbox" id="alarmRepeat"' + (alarmCfg.repeat ? ' checked' : '') + '><i></i></span></label>' +

      '<div class="field" style="margin-top:.9rem"><label>音量 <b id="alarmVolTxt">' +
        Math.round((Number(alarmCfg.vol) || 0.9) * 100) + '%</b></label>' +
        '<input type="range" id="alarmVol" min="10" max="100" step="5" value="' +
        Math.round((Number(alarmCfg.vol) || 0.9) * 100) + '"></div>' +

      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" data-no>关闭</button>' +
        '<button class="btn btn-primary" type="button" id="alarmTest">试听一声</button>' +
      '</div>' +
      '<p class="small muted" style="margin-top:.5rem">听不到声音时依次检查：系统音量 / 浏览器标签是否被静音 / 外接音箱是否接好。</p>');

    function save() {
      alarmCfg = {
        on: back.querySelector('#alarmOn').checked,
        voice: back.querySelector('#alarmVoice').checked,
        repeat: back.querySelector('#alarmRepeat').checked,
        vol: Number(back.querySelector('#alarmVol').value) / 100
      };
      prefs.set('sosAlarm', alarmCfg);
      if (alarmNode) { alarmNode.gain.value = alarmVol(); }   // 正在响时改音量立刻生效
    }

    back.querySelector('#alarmVol').addEventListener('input', function () {
      back.querySelector('#alarmVolTxt').textContent = this.value + '%';
      save();
    });
    ['#alarmOn', '#alarmVoice', '#alarmRepeat'].forEach(function (sel) {
      back.querySelector(sel).addEventListener('change', function () {
        save();
        if (!alarmCfg.on) { stopSound(); }
      });
    });

    back.querySelector('#alarmUnlock').addEventListener('click', async function () {
      var ok = await unlockAudio();
      var box = back.querySelector('#alarmState');
      var t = back.querySelector('#alarmStateTitle');
      var dsc = back.querySelector('#alarmStateDesc');
      if (ok) {
        box.className = 'notice';
        t.textContent = '声音已就绪';
        dsc.textContent = '浏览器已允许本页发声，有求助会立刻响。';
        beepOnce();
        toast('声音已开启', 'ok');
      } else {
        beepOnce();
        t.textContent = '还是没能出声';
        dsc.textContent = '检查系统音量和标签页是否被静音；也可以刷新页面后再点这个按钮。';
        toast('没能开启声音，检查系统音量', 'err');
      }
    });

    back.querySelector('#alarmTest').addEventListener('click', async function () {
      await unlockAudio();
      if (!beepOnce()) { toast('浏览器还没放行声音，点「开启并试听」', 'err'); return; }
      setTimeout(announce, 900);
    });
  }

  /* ---------- 通知通道 ---------- */

  async function openNotify() {
    var d = { config: {}, summary: {} };
    try { d = await API.get('/api/notify'); } catch (e) {}
    var cfg = d.config || {};
    var sum = d.summary || {};
    var order = ['wecom', 'dingtalk', 'serverchan', 'pushplus', 'custom'];
    var rows = order.map(function (k) {
      var c = cfg[k] || {};
      return '<div class="field" style="margin-bottom:.55rem">' +
        '<label>' + esc(c.label || k) +
          (c.configured ? ' <span class="tag tag-ok">已配</span>' : '') + '</label>' +
        '<div style="display:flex;gap:.4rem">' +
          '<input type="text" data-ch="' + k + '" value="' + esc(c.value || '') + '" ' +
            'placeholder="' + esc(c.hint || '') + '" style="flex:1">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-save="' + k + '">保存</button>' +
        '</div>' +
      '</div>';
    }).join('');

    var v = cfg._voice || {};
    var voiceTxt = (v.ak_id && v.ak_secret_set && v.called && v.tts_code)
      ? '<span class="tag tag-ok">已配，可外呼</span>'
      : '<span class="tag tag-warn">未配置</span>';

    var back = modal(
      '<h2>求助通知通道</h2>' +
      '<p class="small muted" style="margin-bottom:.7rem">紧急求助会立刻推到下面已配置的通道。"' +
        '企业微信/钉钉群机器人"最省事：建一个只有家人的群，加个机器人，把地址粘进来。</p>' +
      rows +
      '<div class="card-head" style="margin-top:.8rem"><h2 style="font-size:.95rem">电话外呼 ' + voiceTxt + '</h2></div>' +
      '<p class="small muted" style="margin:.3rem 0 .5rem">阿里云语音通知：需要企业实名 + 已审核的 TTS 模板。' +
        '不填不影响其它通道。</p>' +
      '<div class="row"><div class="field"><label>AccessKeyId</label>' +
        '<input type="text" data-voice="ak_id" value="' + esc(v.ak_id || '') + '"></div>' +
        '<div class="field"><label>AccessKeySecret</label>' +
        '<input type="password" data-voice="ak_secret" placeholder="' + (v.ak_secret_set ? '已保存，留空不改' : '') + '"></div></div>' +
      '<div class="row"><div class="field"><label>被叫号码</label>' +
        '<input type="text" data-voice="called" value="' + esc(v.called || '') + '" placeholder="13800138000"></div>' +
        '<div class="field"><label>TTS 模板号</label>' +
        '<input type="text" data-voice="tts_code" value="' + esc(v.tts_code || '') + '" placeholder="TTS_xxxxxx"></div></div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" data-no>关闭</button>' +
        '<button class="btn btn-ghost" type="button" id="voiceSave">保存外呼</button>' +
        '<button class="btn btn-primary" type="button" id="notifyTest">发一条测试</button>' +
      '</div>' +
      '<p class="small muted" id="notifyMsg" style="margin-top:.5rem;min-height:1.1rem"></p>');

    back.addEventListener('click', async function (e) {
      var s = e.target.closest('[data-save]');
      if (!s) { return; }
      var ch = s.dataset.save;
      var input = back.querySelector('[data-ch="' + ch + '"]');
      try {
        await API.post('/api/notify/config', { channel: ch, value: input.value.trim() });
        toast('已保存', 'ok');
        s.textContent = '已存';
        setTimeout(function () { s.textContent = '保存'; }, 1200);
      } catch (err) { toast(err.message, 'err'); }
    });

    back.querySelector('#voiceSave').addEventListener('click', async function () {
      var body = { voice: {} };
      back.querySelectorAll('[data-voice]').forEach(function (el) {
        body.voice[el.dataset.voice] = el.value.trim();
      });
      try {
        await API.post('/api/notify/config', body);
        toast('外呼配置已保存', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });

    back.querySelector('#notifyTest').addEventListener('click', async function () {
      var btn = back.querySelector('#notifyTest');
      var msg = back.querySelector('#notifyMsg');
      btn.disabled = true; btn.textContent = '发送中…';
      try {
        var r = await API.post('/api/notify/test', {});
        msg.style.color = r.ok ? 'var(--primary)' : 'var(--danger)';
        msg.textContent = r.message;
        toast(r.ok ? '至少一个通道成功了' : '没有通道成功', r.ok ? 'ok' : 'err');
      } catch (err) {
        msg.style.color = 'var(--danger)';
        msg.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = '发一条测试';
      }
    });
  }

  /* ---------- 短信通道 ---------- */

  async function openSms() {
    var d = { config: {}, status: {}, logs: [] };
    try { d = await API.get('/api/sms/config'); } catch (e) {}
    var cfg = d.config || {}, st = d.status || {}, logs = d.logs || [];
    var al = cfg.aliyun || {}, tx = cfg.tencent || {}, cu = cfg.custom || {};

    var hint = st.mode === 'gateway'
      ? '<span class="tag tag-ok">' + esc(st.provider_label) + ' 已接入</span>'
      : '<span class="tag tag-warn">未接入 · 验证码输出到服务端窗口</span>';

    var logRows = logs.length ? logs.map(function (l) {
      return '<tr><td class="small">' + esc((l.created_at || '').slice(5, 16)) + '</td>' +
        '<td class="small">' + esc(l.phone) + '</td><td class="small">' + esc(l.scene) + '</td>' +
        '<td class="small">' + esc(l.channel) + '</td>' +
        '<td class="small" style="color:' + (l.ok ? 'var(--primary)' : 'var(--danger)') + '">' +
          (l.ok ? '成功' : '失败') + '</td>' +
        '<td class="small muted">' + esc((l.message || '').slice(0, 40)) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted small">还没有下发记录</td></tr>';

    var back = modal(
      '<h2>短信通道 ' + hint + '</h2>' +
      '<p class="small muted" style="margin:.3rem 0 .7rem">注册、短信登录、重置密码都靠这条通道；' +
        '紧急求助时也会用它给家属发短信。没接入时只能本机自测。</p>' +
      '<div class="field"><label>服务商</label><select id="smsProvider">' +
        '<option value="">未接入</option>' +
        '<option value="aliyun"' + (cfg.provider === 'aliyun' ? ' selected' : '') + '>阿里云短信</option>' +
        '<option value="tencent"' + (cfg.provider === 'tencent' ? ' selected' : '') + '>腾讯云短信</option>' +
        '<option value="custom"' + (cfg.provider === 'custom' ? ' selected' : '') + '>自定义网关</option>' +
      '</select></div>' +

      '<div id="aliBox" hidden><div class="row"><div class="field"><label>AccessKeyId</label>' +
        '<input data-sms="ali_ak" value="' + esc(al.ak_id || '') + '"></div>' +
        '<div class="field"><label>AccessKeySecret</label>' +
        '<input type="password" data-sms="ali_secret" placeholder="' + (al.ak_secret_set ? '已保存，留空不改' : '') + '"></div></div>' +
        '<div class="row"><div class="field"><label>短信签名</label>' +
        '<input data-sms="ali_sign" value="' + esc(al.sign || '') + '" placeholder="安语养老"></div>' +
        '<div class="field"><label>验证码模板 CODE</label>' +
        '<input data-sms="ali_tpl" value="' + esc(al.tpl_code || '') + '" placeholder="SMS_123456789"></div></div>' +
        '<div class="field"><label>告警短信模板 CODE（可选）</label>' +
        '<input data-sms="ali_tpl_alert" value="' + esc(al.tpl_alert || '') + '" placeholder="SMS_987654321">' +
        '<span class="hint">模板变量：${elder} 老人称呼、${reason} 求助原因</span></div></div>' +

      '<div id="txBox" hidden><div class="row"><div class="field"><label>SecretId</label>' +
        '<input data-sms="tx_id" value="' + esc(tx.secret_id || '') + '"></div>' +
        '<div class="field"><label>SecretKey</label>' +
        '<input type="password" data-sms="tx_key" placeholder="' + (tx.secret_key_set ? '已保存，留空不改' : '') + '"></div></div>' +
        '<div class="row"><div class="field"><label>SdkAppId</label>' +
        '<input data-sms="tx_sdkappid" value="' + esc(tx.sdk_app_id || '') + '" placeholder="1400000000"></div>' +
        '<div class="field"><label>签名</label>' +
        '<input data-sms="tx_sign" value="' + esc(tx.sign || '') + '"></div></div>' +
        '<div class="row"><div class="field"><label>验证码模板 ID</label>' +
        '<input data-sms="tx_tpl" value="' + esc(tx.tpl_code || '') + '"></div>' +
        '<div class="field"><label>告警模板 ID（可选）</label>' +
        '<input data-sms="tx_tpl_alert" value="' + esc(tx.tpl_alert || '') + '"></div></div></div>' +

      '<div id="cuBox" hidden><div class="field"><label>网关地址</label>' +
        '<input data-sms="custom_url" value="' + esc(cu.url || '') + '" placeholder="https://your-gateway/send"></div>' +
        '<div class="field"><label>Token（可选）</label>' +
        '<input type="password" data-sms="custom_token" placeholder="Bearer Token">' +
        '<span class="hint">收到 POST JSON：{phone, scene, code, text}</span></div></div>' +

      '<label class="switch-row" style="margin-top:.4rem"><span class="txt">注册时调用号码百科核验在网状态' +
        '<small>需要阿里云「号码百科」权限；调用失败不阻断注册</small></span>' +
        '<span class="switch"><input type="checkbox" id="smsOnline"' + (cfg.check_online ? ' checked' : '') + '><i></i></span></label>' +

      '<p class="small muted" style="margin:.8rem 0 .3rem">最近下发</p>' +
      '<div class="table-wrap" style="max-height:11rem;overflow:auto"><table class="data">' +
        '<thead><tr><th>时间</th><th>号码</th><th>场景</th><th>通道</th><th>结果</th><th>说明</th></tr></thead>' +
        '<tbody>' + logRows + '</tbody></table></div>' +

      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" data-no>关闭</button>' +
        '<button class="btn btn-ghost" type="button" id="smsTest">发测试短信</button>' +
        '<button class="btn btn-primary" type="button" id="smsSave">保存</button>' +
      '</div>' +
      '<p class="small muted" id="smsMsg" style="margin-top:.5rem;min-height:1.1rem"></p>');

    function syncBoxes() {
      var p = back.querySelector('#smsProvider').value;
      back.querySelector('#aliBox').hidden = p !== 'aliyun';
      back.querySelector('#txBox').hidden = p !== 'tencent';
      back.querySelector('#cuBox').hidden = p !== 'custom';
    }
    back.querySelector('#smsProvider').addEventListener('change', syncBoxes);
    syncBoxes();

    back.querySelector('#smsSave').addEventListener('click', async function () {
      var body = { provider: back.querySelector('#smsProvider').value,
                   check_online: back.querySelector('#smsOnline').checked ? '1' : '0' };
      back.querySelectorAll('[data-sms]').forEach(function (el) {
        body[el.dataset.sms] = el.value.trim();
      });
      try {
        var r = await API.post('/api/sms/config', body);
        var msg = back.querySelector('#smsMsg');
        msg.style.color = r.status.ready ? 'var(--primary)' : 'var(--gold)';
        msg.textContent = r.status.ready
          ? '已保存，短信通道可用（' + r.status.provider_label + '）'
          : '已保存，但配置还不完整，暂时发不出短信';
        toast('已保存', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });

    back.querySelector('#smsTest').addEventListener('click', async function () {
      var phone = window.prompt('发一条测试短信到哪个手机号？');
      if (!phone) { return; }
      var msg = back.querySelector('#smsMsg');
      try {
        var r = await API.post('/api/sms/test', { phone: phone });
        msg.style.color = r.ok ? 'var(--primary)' : 'var(--danger)';
        msg.textContent = r.message;
      } catch (err) {
        msg.style.color = 'var(--danger)';
        msg.textContent = err.message;
      }
    });
  }

  /* ---------- AI 值守 ---------- */

  async function openDuty() {
    var d = { status: {}, runs: [] };
    try { d = await API.get('/api/console/duty'); } catch (e) {}
    var st = d.status || {};
    var runs = d.runs || [];

    function runRow(r) {
      var plan = {};
      try { plan = JSON.parse(r.plan || '{}'); } catch (e) {}
      var acts = [];
      try { acts = JSON.parse(r.actions || '[]'); } catch (e) {}
      var closed = r.alert_status === 'closed';
      return '<div class="med-row" style="align-items:flex-start">' +
        '<div class="med-main" style="flex:1">' +
          '<b>#' + r.alert_id + ' ' + esc((r.title || '').slice(0, 26)) + '</b>' +
          '<small>' + esc((r.created_at || '').slice(5, 16)) + ' · ' +
            esc(r.mode === 'llm' ? '大模型' : '规则') + ' · 风险 ' + esc(r.risk || '—') + ' · ' +
            (closed ? '已自动结案' : '待真人跟进') + '</small>' +
          '<small style="display:block;margin-top:.2rem;color:var(--ink-2)">' +
            esc(acts.join(' → ').slice(0, 90) + (acts.join(' → ').length > 90 ? '…' : '')) + '</small>' +
        '</div>' +
        '<span class="tag ' + (closed ? 'tag-ok' : 'tag-warn') + '">' +
          (closed ? '已闭环' : '跟进中') + '</span>' +
      '</div>';
    }

    var back = modal(
      '<h2>AI 值守</h2>' +
      '<p class="small muted" style="margin-bottom:.7rem">开启后，新工单由' +
        (st.mode === 'llm' ? '大模型（' + esc(st.model || '') + '）' : '规则引擎') +
        '自动接单并处置，每一步都写进事件时间线。</p>' +
      '<div class="switch-row">' +
        '<span class="txt">自动接单<small>关掉后恢复人工值守</small></span>' +
        '<label class="switch"><input type="checkbox" id="dutyToggle"' +
          (st.enabled ? ' checked' : '') + '><i aria-hidden="true"></i></label>' +
      '</div>' +
      '<ul class="small muted" style="margin:.6rem 0 .8rem;padding-left:1.1rem;line-height:1.7">' +
        '<li>自动接单 → 生成处置方案 → 给老人和家属留言 → 结案或升级</li>' +
        '<li><b>紧急求助只接单、不自动结案</b>，必须由真人确认安全</li>' +
        '<li>模型不许改数据，只出方案；动作由服务端执行并留痕</li>' +
        '<li>自动结错的单，可以在工单里「重新打开」</li>' +
      '</ul>' +
      '<p class="small muted" style="margin-bottom:.4rem">最近处置 ' + runs.length + ' 条</p>' +
      '<div id="dutyRuns" style="max-height:14rem;overflow-y:auto">' +
        (runs.length ? runs.map(runRow).join('')
                     : '<div class="empty">还没有自动处置记录</div>') +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" data-no>关闭</button>' +
        '<button class="btn btn-ghost" type="button" id="dutyRun">立即处理一轮</button>' +
      '</div>' +
      '<p class="small small muted" id="dutyMsg" style="margin-top:.5rem;min-height:1.1rem"></p>');

    back.querySelector('#dutyToggle').addEventListener('change', async function (e) {
      var msg = back.querySelector('#dutyMsg');
      try {
        var r = await API.post('/api/console/duty', { enabled: e.target.checked });
        msg.style.color = 'var(--primary)';
        msg.textContent = r.status.enabled
          ? '已开启，新工单会在几秒内被自动接管。'
          : '已关闭，恢复人工值守。';
        toast(r.status.enabled ? 'AI 值守已开启' : 'AI 值守已关闭', 'ok');
        syncDutyDot(r.status.enabled);
        await loadBoard();
      } catch (err) {
        msg.style.color = 'var(--danger)';
        msg.textContent = err.message;
        e.target.checked = !e.target.checked;
      }
    });

    back.querySelector('#dutyRun').addEventListener('click', async function () {
      var btn = back.querySelector('#dutyRun');
      var msg = back.querySelector('#dutyMsg');
      btn.disabled = true;
      btn.textContent = '处理中…';
      try {
        var r = await API.post('/api/console/duty/run', {});
        var n = (r.handled || []).filter(function (x) { return x.ok; }).length;
        msg.style.color = 'var(--primary)';
        msg.textContent = n ? '已处置 ' + n + ' 条，刷新中…' : '当前没有待接单的工单。';
        toast(n ? 'AI 已处置 ' + n + ' 条' : '没有待接单工单', n ? 'ok' : 'err');
        await loadAll();
        if (n) { back.remove(); openDuty(); }
      } catch (err) {
        msg.style.color = 'var(--danger)';
        msg.textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '立即处理一轮';
      }
    });
  }

  function syncDutyDot(on) {
    var dot = $('#dutyDot');
    if (dot) { dot.style.display = on ? 'inline-block' : 'none'; }
  }

  function openAddElder() {
    var back = modal(
      '<h2>新增老人</h2><p class="small muted" style="margin-bottom:.8rem">档案建好后，可以在「成员」里开对应的老人/家属账号。</p>' +
      '<form id="addElderForm">' +
        '<div class="row"><div class="field"><label>姓名</label><input id="eName" type="text" required></div>' +
        '<div class="field"><label>称呼</label><input id="eDisplay" type="text" placeholder="张阿姨"></div></div>' +
        '<div class="row-3"><div class="field"><label>年龄</label><input id="eAge" type="number"></div>' +
        '<div class="field"><label>设备</label><select id="eDevice"><option value="online">在线</option><option value="offline">离线</option></select></div></div>' +
        '<div class="field"><label>住址</label><input id="eAddr" type="text"></div>' +
        '<div class="row"><div class="field"><label>基础病</label><input id="eCond" type="text"></div>' +
        '<div class="field"><label>过敏</label><input id="eAllergy" type="text"></div></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" type="button" data-no>取消</button>' +
        '<button class="btn btn-primary" type="submit">保存</button></div>' +
      '</form>');
    back.querySelector('#addElderForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        await API.post('/api/elders', {
          elder: {
            name: back.querySelector('#eName').value.trim(),
            display: back.querySelector('#eDisplay').value.trim(),
            age: Number(back.querySelector('#eAge').value) || null,
            address: back.querySelector('#eAddr').value.trim(),
            conditions: back.querySelector('#eCond').value.trim(),
            allergies: back.querySelector('#eAllergy').value.trim(),
            blood_type: '',
            community: ''
          }
        });
        toast('已新增', 'ok');
        back.remove();
        loadAll();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  /* ---------- 绑定 ---------- */

  $$('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      tab = b.dataset.tab;
      $$('.tab').forEach(function (x) {
        var on = x === b;
        x.classList.toggle('on', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      loadBoard();
    });
  });

  $('#orderList').addEventListener('click', function (e) {
    var card = e.target.closest('[data-id]');
    if (card) { openDetail(Number(card.dataset.id)); }
  });

  $('#detailBody').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (b) { doAction(b.dataset.act); }
  });

  $('#refreshBtn').addEventListener('click', function () { loadAll(); toast('已刷新'); });
  $('#usersBtn').addEventListener('click', openUsers);
  $('#llmBtn').addEventListener('click', openLlm);
  $('#dutyBtn').addEventListener('click', openDuty);
  $('#notifyBtn').addEventListener('click', openNotify);
  var alarmBtn = $('#alarmBtn');
  if (alarmBtn) { alarmBtn.addEventListener('click', openAlarm); }
  var smsBtn = $('#smsBtn');
  if (smsBtn) { smsBtn.addEventListener('click', openSms); }

  /* 浏览器要求先有用户手势才能出声：点过任意位置就顺手把声音解锁，并更新按钮状态 */
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (audioState() !== 'running') { unlockAudio(); }
    }, { passive: true });
  });
  syncAlarmBtn();
  $('#addElderBtn').addEventListener('click', openAddElder);

  /* ---------- 启动 ---------- */

  (async function init() {
    applyA11y();
    try {
      var r = await API.get('/api/me');
      me = r.user;
      bindTopbar(me);
      $('#eyebrow').textContent = '值守台 · ' + me.name;
      syncAlarmBtn();
    } catch (e) { return; }
    await loadAll();
    try {
      var ds = await API.get('/api/console/duty');
      syncDutyDot((ds.status || {}).enabled);
    } catch (e) {}
    setInterval(function () {
      loadBoard();
      loadMetrics();
      $$('[data-sla]').forEach(function (el) {
        var a = orders.filter(function (x) { return x.id === Number(el.dataset.sla); })[0];
        if (!a) { return; }
        var s = slaOf(a);
        el.textContent = s.text;
        el.classList.toggle('over', !!s.cls);
      });
    }, 5000);
    setInterval(loadRoster, 20000);
  })();
})();
