/* 首次设置向导 */
(function () {
  'use strict';

  var step = 1;

  function show(n) {
    step = n;
    [1, 2, 3].forEach(function (i) {
      $('#step' + i).hidden = i !== n;
      $('#s' + i).classList.toggle('on', i <= n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $$('[data-next]').forEach(function (b) {
    b.addEventListener('click', function () {
      var target = Number(b.dataset.next);
      if (step === 1 && !$('#name').value.trim()) {
        toast('请先填老人姓名', 'err');
        $('#name').focus();
        return;
      }
      show(target);
    });
  });
  $$('[data-back]').forEach(function (b) {
    b.addEventListener('click', function () { show(Number(b.dataset.back)); });
  });

  /* 用药行 */
  function medRow(name, dose, time, meal) {
    var div = document.createElement('div');
    div.className = 'row-3';
    div.style.marginBottom = '.6rem';
    div.innerHTML =
      '<div class="field" style="margin:0"><label class="sr-only">药名</label>' +
        '<input type="text" data-k="name" placeholder="药名，如 苯磺酸氨氯地平片" value="' + esc(name || '') + '"></div>' +
      '<div class="field" style="margin:0"><label class="sr-only">剂量</label>' +
        '<input type="text" data-k="dose" placeholder="剂量，如 1 片" value="' + esc(dose || '1 片') + '"></div>' +
      '<div class="field" style="margin:0;display:flex;gap:.4rem"><label class="sr-only">时间</label>' +
        '<input type="time" data-k="time" value="' + esc(time || '08:00') + '">' +
        '<button class="icon-btn" type="button" data-del aria-label="删除这种药">✕</button></div>';
    div.querySelector('[data-del]').addEventListener('click', function () { div.remove(); });
    return div;
  }

  $('#addMed').addEventListener('click', function () {
    $('#medRows').appendChild(medRow('', '1 片', '08:00', ''));
  });
  $('#medRows').appendChild(medRow('', '1 片', '08:00', ''));
  $('#medRows').appendChild(medRow('', '1 片', '12:30', ''));

  function collectMeds() {
    return $$('#medRows .row-3').map(function (row) {
      var get = function (k) { return row.querySelector('[data-k="' + k + '"]').value.trim(); };
      return { name: get('name'), dose: get('dose'), time: get('time'), meal: '' };
    }).filter(function (m) { return m.name && m.time; });
  }

  function fail(msg, el) {
    $('#setupErr').textContent = msg;
    if (el) { el.focus(); }
    toast(msg, 'err');
  }

  $('#setupForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var phoneRe = /^1[3-9]\d{9}$/;
    var elderPhone = $('#elderPhone').value.trim();
    var famPhone = $('#famPhone').value.trim();
    var comPhone = $('#comPhone').value.trim();
    var elderPwd = $('#elderPwd').value;
    var famPwd = $('#famPwd').value;
    var comPwd = $('#comPwd').value;

    if (!phoneRe.test(elderPhone)) { return fail('老人账号手机号格式不对', $('#elderPhone')); }
    if (!phoneRe.test(famPhone)) { return fail('家属账号手机号格式不对', $('#famPhone')); }
    if (!phoneRe.test(comPhone)) { return fail('社区账号手机号格式不对', $('#comPhone')); }
    if (elderPwd.length < 6) { return fail('老人账号密码至少 6 位', $('#elderPwd')); }
    if (famPwd.length < 6) { return fail('家属账号密码至少 6 位', $('#famPwd')); }
    if (comPwd.length < 6) { return fail('社区账号密码至少 6 位', $('#comPwd')); }
    if (new Set([elderPhone, famPhone, comPhone]).size !== 3) { return fail('三个账号的手机号不能重复'); }

    var btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '正在创建…';
    $('#setupErr').textContent = '';
    try {
      await API.post('/api/setup', {
        elder: {
          name: $('#name').value.trim(),
          display: $('#display').value.trim(),
          age: Number($('#age').value) || null,
          address: $('#address').value.trim(),
          blood_type: $('#bloodType').value.trim(),
          conditions: $('#conditions').value.trim(),
          allergies: $('#allergies').value.trim(),
          community: $('#community').value.trim()
        },
        elder_login: { phone: elderPhone, password: elderPwd },
        family: {
          name: $('#famName').value.trim() || '家属',
          relation: $('#famRelation').value.trim() || '家属',
          phone: famPhone, password: famPwd
        },
        community: {
          name: $('#comName').value.trim() || '网格员',
          phone: comPhone, password: comPwd
        },
        meds: collectMeds()
      });
      toast('设置完成，请用刚才的手机号登录', 'ok');
      setTimeout(function () { location.href = '/login.html?done=1'; }, 900);
    } catch (err) {
      fail(err.message || '创建失败');
      btn.disabled = false;
      btn.textContent = '完成设置';
    }
  });
})();
