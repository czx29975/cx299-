/* 登录：密码登录 / 短信验证码登录 / 忘记密码（短信重置） */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  if (params.get('done') === '1') { $('#doneHint').hidden = false; }

  var HOME = { elder: '/elder.html', family: '/family.html', community: '/console.html', admin: '/console.html' };
  var mode = 'pwd';
  var captchaToken = '';

  (async function () {
    try {
      var me = await API.get('/api/me', { silent: true });
      if (me && me.user) { location.href = HOME[me.user.role] || '/'; }
    } catch (e) { /* 未登录，留在本页 */ }
  })();

  /* ---------- 图形验证码 ---------- */

  async function loadCaptcha() {
    var box = $('#captchaBox');
    box.innerHTML = '<span class="small muted">加载中…</span>';
    try {
      var d = await API.get('/api/captcha', { silent: true });
      captchaToken = d.token;
      box.innerHTML = d.svg;
    } catch (e) {
      box.innerHTML = '<span class="small muted">点此重试</span>';
    }
  }

  $('#captchaBox').addEventListener('click', function () {
    $('#captcha').value = '';
    loadCaptcha();
  });

  /* ---------- 模式切换 ---------- */

  function applyMode(m) {
    mode = m;
    var title = { pwd: '登录', sms: '短信登录', reset: '重置密码' }[m];
    $('#authTitle').textContent = title;
    $('#loginBtn').textContent = m === 'reset' ? '重置并登录' : '登录';
    $('#pwdLabel').textContent = m === 'reset' ? '新密码' : '密码';
    $('#password').setAttribute('autocomplete', m === 'reset' ? 'new-password' : 'current-password');
    $('#password').placeholder = m === 'reset' ? '至少 6 位' : '登录密码';
    $('#pwdWrap').hidden = (m === 'sms');
    $('#smsWrap').hidden = (m === 'pwd');
    $('#modeTabs').hidden = (m === 'reset');
    $('#loginErr').textContent = '';
    $$('#modeTabs .tab').forEach(function (t) {
      var on = t.dataset.mode === m;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (m !== 'pwd' && !captchaToken) { loadCaptcha(); }
    if (m === 'reset') {
      $('#loginBtn').textContent = '重置密码';
    }
  }

  $$('#modeTabs .tab').forEach(function (t) {
    t.addEventListener('click', function () { applyMode(t.dataset.mode); });
  });

  $('#forgotLink').addEventListener('click', function (e) {
    e.preventDefault();
    applyMode('reset');
    toast('输入手机号，收验证码后直接设新密码');
  });

  /* ---------- 发验证码 ---------- */

  var timer = null;
  function countdown(sec) {
    var btn = $('#sendBtn');
    var left = sec;
    btn.disabled = true;
    btn.textContent = left + ' 秒后重发';
    clearInterval(timer);
    timer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = '重新获取';
        return;
      }
      btn.textContent = left + ' 秒后重发';
    }, 1000);
  }

  $('#sendBtn').addEventListener('click', async function () {
    var phone = $('#phone').value.trim();
    var cap = $('#captcha').value.trim();
    if (!/^1\d{10}$/.test(phone)) { $('#loginErr').textContent = '请先填 11 位手机号'; return; }
    if (!cap) { $('#loginErr').textContent = '请先填图形验证码'; $('#captcha').focus(); return; }
    $('#loginErr').textContent = '';
    try {
      var r = await API.post('/api/auth/sms/send', {
        phone: phone, scene: (mode === 'reset' ? 'reset' : 'login'),
        captcha: cap, captcha_token: captchaToken
      });
      countdown(58);
      if (r.dev_code) {
        $('#code').value = r.dev_code;
        toast('未接入短信网关，验证码：' + r.dev_code);
      } else {
        toast(r.message || '验证码已发送');
      }
    } catch (err) {
      $('#loginErr').textContent = err.message;
      loadCaptcha();
      $('#captcha').value = '';
    }
  });

  /* ---------- 提交 ---------- */

  $('#loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var phone = $('#phone').value.trim();
    var pwd = $('#password').value;
    var err = $('#loginErr');
    err.textContent = '';
    var btn = $('#loginBtn');

    if (!/^1\d{10}$/.test(phone)) { err.textContent = '请填写 11 位手机号'; return; }

    var url = '/api/auth/login';
    var body = { phone: phone, password: pwd };
    if (mode === 'pwd') {
      if (!pwd) { err.textContent = '请填写密码'; return; }
    } else {
      var code = $('#code').value.trim();
      if (!/^\d{6}$/.test(code)) { err.textContent = '请填写 6 位短信验证码'; return; }
      if (mode === 'reset') {
        if (pwd.length < 6) { err.textContent = '新密码至少 6 位'; return; }
        url = '/api/auth/reset';
        body = { phone: phone, password: pwd, code: code };
      } else {
        url = '/api/auth/sms_login';
        body = { phone: phone, code: code };
      }
    }

    btn.disabled = true;
    btn.textContent = '处理中…';
    try {
      var r = await API.post(url, body);
      if (mode === 'reset') {
        toast('密码已重置，请用新密码登录');
        applyMode('pwd');
        $('#password').value = '';
        btn.disabled = false;
        btn.textContent = '登录';
        return;
      }
      toast('欢迎回来，' + r.user.name);
      var next = params.get('next');
      location.href = next && next.indexOf('/') === 0 ? next : (HOME[r.user.role] || '/');
    } catch (ex) {
      err.textContent = ex.message || '登录失败';
      btn.disabled = false;
      btn.textContent = mode === 'reset' ? '重置密码' : '登录';
      if (mode !== 'pwd') { loadCaptcha(); $('#captcha').value = ''; }
    }
  });
})();
