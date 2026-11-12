/* 注册：短信验证码 + 图形码 + 绑定老人 */
(function () {
  'use strict';

  var HOME = { elder: '/elder.html', family: '/family.html', community: '/console.html', admin: '/console.html' };
  var role = 'family';
  var bindMode = 'code';
  var captchaToken = '';
  var sending = false;

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

  /* ---------- 短信网关状态 ---------- */

  (async function () {
    try {
      var s = await API.get('/api/sms/status', { silent: true });
      var el = $('#smsHint');
      el.hidden = false;
      if (s.mode === 'console') {
        el.className = 'notice notice-warn';
        el.innerHTML = '<b>还没有接入短信网关</b>' +
          '<div class="small">现在验证码不会真的发到手机上，而是打印在服务端窗口，并且发送后会直接显示在页面里。' +
          '正式启用请在「社区端 · 短信」里填阿里云或腾讯云短信配置。</div>';
      } else {
        el.className = 'notice';
        el.innerHTML = '<b>短信通道：' + esc(s.provider_label) + '</b>' +
          '<div class="small">验证码会发送到你的手机上。手机号会做号段校验，虚拟运营商号码不能注册。</div>';
      }
    } catch (e) { /* 离线也能继续 */ }
  })();

  /* ---------- 身份 / 绑定方式切换 ---------- */

  $$('[data-role]').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('[data-role]').forEach(function (x) {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', x === b ? 'true' : 'false');
      });
      role = b.dataset.role;
      $('#nameLabel').textContent = role === 'elder' ? '您的姓名' : '您的姓名';
      $('#relationField').hidden = role === 'elder';
      $('#elderName').placeholder = role === 'elder' ? '请填您自己的姓名' : '王秀兰';
      $('#regErr').textContent = '';
    });
  });

  $$('[data-bind]').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('[data-bind]').forEach(function (x) {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', x === b ? 'true' : 'false');
      });
      bindMode = b.dataset.bind;
      $('#bindCodeWrap').hidden = bindMode !== 'code';
      $('#bindNewWrap').hidden = bindMode !== 'new';
      $('#regErr').textContent = '';
    });
  });

  /* ---------- 发送验证码 ---------- */

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
    if (sending) { return; }
    var phone = $('#phone').value.trim();
    var cap = $('#captcha').value.trim();
    if (!/^1\d{10}$/.test(phone)) {
      $('#regErr').textContent = '请先填 11 位手机号';
      return;
    }
    if (!cap) {
      $('#regErr').textContent = '请先填右边的图形验证码';
      $('#captcha').focus();
      return;
    }
    sending = true;
    $('#regErr').textContent = '';
    try {
      var r = await API.post('/api/auth/sms/send', {
        phone: phone, scene: 'register', captcha: cap, captcha_token: captchaToken
      });
      countdown(58);
      if (r.dev_code) {
        $('#code').value = r.dev_code;
        toast('未接入网关，验证码已自动填入：' + r.dev_code);
      } else {
        toast(r.message || '验证码已发送');
      }
    } catch (err) {
      $('#regErr').textContent = err.message;
      loadCaptcha();
      $('#captcha').value = '';
    } finally {
      sending = false;
    }
  });

  /* ---------- 提交 ---------- */

  $('#regForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#regErr');
    err.textContent = '';
    var body = {
      role: role,
      name: $('#name').value.trim(),
      relation: $('#relation').value.trim(),
      phone: $('#phone').value.trim(),
      code: $('#code').value.trim(),
      password: $('#password').value
    };
    if (!body.name || body.name.length < 2) { err.textContent = '请填写真实姓名'; return; }
    if (!/^1\d{10}$/.test(body.phone)) { err.textContent = '手机号应该是 11 位数字'; return; }
    if (!/^\d{6}$/.test(body.code)) { err.textContent = '请填写 6 位短信验证码'; return; }
    if (body.password.length < 6) { err.textContent = '密码至少 6 位'; return; }
    if (body.password !== $('#password2').value) { err.textContent = '两次输入的密码不一致'; return; }

    if (bindMode === 'code') {
      body.invite = $('#invite').value.trim().toUpperCase();
      if (!body.invite) { err.textContent = '请填社区给的 6 位绑定码，或改成「新建档案」'; return; }
    } else {
      body.elder = {
        name: $('#elderName').value.trim(),
        age: $('#elderAge').value.trim(),
        display: $('#elderDisplay').value.trim(),
        community: $('#elderCommunity').value.trim(),
        address: $('#elderAddress').value.trim()
      };
      if (!body.elder.name || body.elder.name.length < 2) {
        err.textContent = '请填写老人姓名'; return;
      }
    }

    var btn = $('#regBtn');
    btn.disabled = true;
    btn.textContent = '正在注册…';
    try {
      var r = await API.post('/api/auth/register', body);
      toast('注册成功，正在进入' + (r.user.role === 'elder' ? '老人端' : '家属端'));
      setTimeout(function () { location.href = HOME[r.user.role] || '/'; }, 400);
    } catch (ex) {
      err.textContent = ex.message || '注册失败';
      btn.disabled = false;
      btn.textContent = '注册并登录';
      loadCaptcha();
      $('#captcha').value = '';
    }
  });

  loadCaptcha();
})();
