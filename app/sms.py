"""短信验证码：号码真实性校验、人机校验、频控、多渠道下发。

为什么这块要认真做：

1. 家属手机号是出事时**唯一能叫醒人**的通道。虚拟运营商号（170/171/162/165/167）、
   物联网卡、卫星号收不到短信，也经常打不通电话，所以注册阶段就拦住，
   不让它混进紧急联系人名单。
2. 系统可以开在公网地址上，裸的"发码"接口等于一台短信轰炸机。
   所以先过图形码、再按手机号 / IP 双向频控，验证码只存哈希、5 分钟失效、错 5 次作废。
3. 不假装成功。没配网关时就在服务端窗口打码（本地自测用），
   配了网关走真实通道，失败原因原文写进 sms_sends，能回查。

支持的通道（都是纯标准库实现，不引第三方包）：
  阿里云短信 SendSms / 腾讯云短信 SendSms / 自定义 HTTP 网关
"""
import hashlib
import hmac
import json
import random
import re
import secrets
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta

import db

TIMEOUT = 10
CODE_TTL = 300            # 秒：验证码有效期 5 分钟
CODE_LEN = 6
MAX_ATTEMPTS = 5          # 同一条码最多试 5 次
RESEND_GAP = 60           # 秒：同号同场景 60 秒内不重发
PHONE_DAY_LIMIT = 10      # 同一手机号 24 小时最多 10 条
IP_HOUR_LIMIT = 12        # 同一 IP 每小时最多 12 条
IP_DAY_LIMIT = 40         # 同一 IP 每天最多 40 条
CAPTCHA_TTL = 180         # 秒：图形码 3 分钟

SCENES = {
    "register": "注册",
    "login": "登录",
    "reset": "重置密码",
    "bind": "绑定手机号",
}

# ---------------- 号段 ----------------

# 中国大陆移动电话号段（工信部分配）。只认这些，其余一律不收。
ALLOWED_PREFIX = {
    # 中国移动
    "134", "135", "136", "137", "138", "139", "147", "150", "151", "152",
    "157", "158", "159", "172", "178", "182", "183", "184", "187", "188",
    "195", "197", "198",
    # 中国联通
    "130", "131", "132", "145", "155", "156", "166", "175", "176", "185",
    "186", "196",
    # 中国电信
    "133", "149", "153", "173", "177", "180", "181", "189", "190", "191",
    "193", "199",
    # 中国广电
    "192",
}

# 虚拟运营商（移动转售）号段：接码平台最爱用，收得到短信但没人负责，紧急时找不到人
VIRTUAL_PREFIX = {
    "162": "中国电信转售",
    "165": "中国移动转售",
    "167": "中国联通转售",
    "170": "虚拟运营商（1700/1705/1709）",
    "171": "中国联通转售",
}

# 物联网 / 上网卡 / 卫星 / 行业应用号段：不是自然人手机号
MACHINE_PREFIX = {
    "140": "物联网专用号段", "141": "物联网专用号段", "142": "物联网专用号段",
    "143": "物联网专用号段", "144": "物联网专用号段", "146": "物联网专用号段",
    "148": "物联网专用号段", "174": "卫星通信号段", "106": "行业短信端口",
}

PHONE_RE = re.compile(r"^1\d{10}$")


def normalize(phone):
    """去掉空格、横线、+86 前缀，返回纯 11 位数字。"""
    s = re.sub(r"[\s\-()]", "", str(phone or ""))
    s = re.sub(r"^(\+?86)", "", s)
    s = re.sub(r"[^\d]", "", s)
    return s


def check_phone(phone):
    """判断这个号能不能当真人在用的手机号。

    返回 (ok, reason, phone)；reason 直接给用户看，说清楚为什么不行。
    """
    p = normalize(phone)
    if not p:
        return False, "请填写手机号", p
    if len(p) != 11 or not PHONE_RE.match(p):
        if p.startswith(("400", "800", "95", "96", "10", "1")):
            return False, "这不是手机号，请填 11 位手机号（座机、400、95 开头都不行）", p
        return False, "手机号应该是 11 位数字", p
    pre = p[:3]
    if pre in VIRTUAL_PREFIX:
        return False, ("%s 属于虚拟运营商号码（%s），出事时经常无人接听、也无法回拨，"
                       "为了家属能被联系上，请换一个移动/联通/电信/广电的实名手机号" %
                       (p, VIRTUAL_PREFIX[pre])), p
    if pre in MACHINE_PREFIX:
        return False, "%s 属于%s，不是个人手机号，收不到也接不了紧急电话" % (p, MACHINE_PREFIX[pre]), p
    if pre not in ALLOWED_PREFIX:
        return False, "号段 %s 不是有效的大陆手机号段，请核对后再填" % pre, p
    tail = p[3:]
    if len(set(tail)) == 1:
        return False, "这个号码（尾号 %s）不像真实在用的手机号，请重新填写" % tail, p
    if tail in ("12345678", "23456789", "01234567"):
        return False, "这个号码（尾号 %s）不像真实在用的手机号，请重新填写" % tail, p
    return True, "", p


# ---------------- 图形验证码 ----------------

ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def _svg(code):
    rnd = random.Random()
    parts = []
    for i in range(5):
        x1, y1 = rnd.randint(0, 20), rnd.randint(4, 40)
        x2, y2 = rnd.randint(100, 130), rnd.randint(4, 40)
        parts.append('<path d="M%d %d Q%d %d %d %d" fill="none" stroke="#D9CBB4" '
                     'stroke-width="1.4" opacity=".75"/>' %
                     (x1, y1, rnd.randint(20, 80), rnd.randint(0, 44), x2, y2))
    for i, ch in enumerate(code):
        x = 16 + i * 25 + rnd.randint(-3, 3)
        y = 30 + rnd.randint(-3, 3)
        rot = rnd.randint(-14, 14)
        color = rnd.choice(["#3B3226", "#4A3F2E", "#2F4F43", "#5A4632"])
        parts.append('<text x="%d" y="%d" font-size="26" font-weight="700" fill="%s" '
                     'font-family="ui-sans-serif,system-ui,Segoe UI,sans-serif" '
                     'transform="rotate(%d %d %d)">%s</text>' % (x, y, color, rot, x, y, ch))
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 124 44" width="124" height="44" '
            'role="img" aria-label="图形验证码">'
            '<rect width="124" height="44" rx="6" fill="#F4EEE2"/>' + "".join(parts) + "</svg>")


def issue_captcha():
    """生成图形码。答案只存在服务端，前端拿到的是一张 SVG。"""
    code = "".join(secrets.choice(ALPHABET) for _ in range(4))
    token = secrets.token_urlsafe(18)
    now = datetime.now()
    db.ex("INSERT INTO captchas(token,answer,created_at,expires_at) VALUES(?,?,?,?)",
          (token, code,
           now.strftime("%Y-%m-%d %H:%M:%S"),
           (now + timedelta(seconds=CAPTCHA_TTL)).strftime("%Y-%m-%d %H:%M:%S")))
    # 顺手清理过期图形码，免得表一直长
    db.ex("DELETE FROM captchas WHERE expires_at < ?", (db.now(),))
    return {"token": token, "svg": _svg(code), "ttl": CAPTCHA_TTL}


def check_captcha(token, answer):
    if not token or not answer:
        return False, "请先填图形验证码"
    row = db.q1("SELECT * FROM captchas WHERE token=?", (token,))
    if not row:
        return False, "图形验证码已失效，请刷新重试"
    db.ex("DELETE FROM captchas WHERE token=?", (token,))   # 一次性
    if row["expires_at"] < db.now():
        return False, "图形验证码已过期，请刷新重试"
    if str(answer).strip().upper() != row["answer"].upper():
        return False, "图形验证码不对，请重新输入"
    return True, ""


# ---------------- 频控 ----------------

def _count(sql, args):
    r = db.q1(sql, args)
    return int(r["n"]) if r else 0


def rate_limit(phone, ip):
    """发码前的三道闸：同号 60 秒、同号每天 10 条、同 IP 每小时/每天。"""
    r = db.q1("SELECT created_at FROM sms_codes WHERE phone=? ORDER BY id DESC LIMIT 1", (phone,))
    if r:
        try:
            gap = (datetime.now() - datetime.strptime(r["created_at"], "%Y-%m-%d %H:%M:%S")).total_seconds()
        except Exception:
            gap = 999
        if gap < RESEND_GAP:
            return False, int(RESEND_GAP - gap)
    day_ago = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
    if _count("SELECT COUNT(*) n FROM sms_codes WHERE phone=? AND created_at>=?", (phone, day_ago)) >= PHONE_DAY_LIMIT:
        return False, 0
    if ip:
        hour_ago = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")
        if _count("SELECT COUNT(*) n FROM sms_codes WHERE ip=? AND created_at>=?", (ip, hour_ago)) >= IP_HOUR_LIMIT:
            return False, 0
        if _count("SELECT COUNT(*) n FROM sms_codes WHERE ip=? AND created_at>=?", (ip, day_ago)) >= IP_DAY_LIMIT:
            return False, 0
    return True, 0


# ---------------- 网关配置 ----------------

GATEWAYS = {
    "aliyun": "阿里云短信",
    "tencent": "腾讯云短信",
    "custom": "自定义网关",
}


def _s(key, default=""):
    return (db.setting_get(key) or default).strip()


def config():
    return {
        "provider": _s("sms_provider"),
        "aliyun": {
            "ak_id": _s("sms_ali_ak"),
            "ak_secret_set": bool(_s("sms_ali_secret")),
            "sign": _s("sms_ali_sign"),
            "tpl_code": _s("sms_ali_tpl"),
            "tpl_alert": _s("sms_ali_tpl_alert"),
        },
        "tencent": {
            "secret_id": _s("sms_tx_id"),
            "secret_key_set": bool(_s("sms_tx_key")),
            "sdk_app_id": _s("sms_tx_sdkappid"),
            "sign": _s("sms_tx_sign"),
            "tpl_code": _s("sms_tx_tpl"),
            "tpl_alert": _s("sms_tx_tpl_alert"),
        },
        "custom": {
            "url": _s("sms_custom_url"),
            "token": _s("sms_custom_token"),
        },
        "check_online": _s("sms_check_online") == "1",
    }


def set_config(body):
    """只写传进来的字段，没传的不动（密钥留空表示不改）。"""
    m = {
        "provider": "sms_provider",
        "ali_ak": "sms_ali_ak", "ali_secret": "sms_ali_secret",
        "ali_sign": "sms_ali_sign", "ali_tpl": "sms_ali_tpl", "ali_tpl_alert": "sms_ali_tpl_alert",
        "tx_id": "sms_tx_id", "tx_key": "sms_tx_key", "tx_sdkappid": "sms_tx_sdkappid",
        "tx_sign": "sms_tx_sign", "tx_tpl": "sms_tx_tpl", "tx_tpl_alert": "sms_tx_tpl_alert",
        "custom_url": "sms_custom_url", "custom_token": "sms_custom_token",
        "check_online": "sms_check_online",
    }
    for k, key in m.items():
        if k in body and body[k] is not None:
            v = body[k]
            if k in ("ali_secret", "tx_key") and not str(v).strip():
                continue          # 密钥留空 = 不修改
            db.setting_set(key, str(v).strip())
    return config()


def provider_ready():
    c = config()
    p = c["provider"]
    if p == "aliyun":
        a = c["aliyun"]
        return bool(a["ak_id"] and a["ak_secret_set"] and a["sign"] and a["tpl_code"])
    if p == "tencent":
        t = c["tencent"]
        return bool(t["secret_id"] and t["secret_key_set"] and t["sdk_app_id"]
                    and t["sign"] and t["tpl_code"])
    if p == "custom":
        return bool(c["custom"]["url"])
    return False


def status():
    c = config()
    return {
        "provider": c["provider"],
        "provider_label": GATEWAYS.get(c["provider"], "未配置"),
        "ready": provider_ready(),
        "check_online": c["check_online"],
        "mode": "gateway" if provider_ready() else "console",
        "sent_24h": _count("SELECT COUNT(*) n FROM sms_sends WHERE created_at>=?",
                           ((datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S"),)),
    }


# ---------------- 发送实现 ----------------

def _pct(s):
    import urllib.parse
    return urllib.parse.quote(str(s), safe="~")


def _ali_sign(params, secret):
    import base64
    items = sorted(params.items())
    canon = "&".join("%s=%s" % (_pct(k), _pct(v)) for k, v in items)
    sts = "GET&%2F&" + _pct(canon)
    sig = base64.b64encode(hmac.new((secret + "&").encode(), sts.encode(), hashlib.sha1).digest()).decode()
    return "https://dysmsapi.aliyuncs.com/?Signature=%s&%s" % (_pct(sig), canon)


def _send_aliyun(phone, scene, code, text):
    c = config()["aliyun"]
    if scene == "alert":
        tpl = c["tpl_alert"]
        param = {"elder": "", "reason": ""}
    else:
        tpl = c["tpl_code"]
        param = {"code": code}
    if not tpl:
        return False, "missing", "没有配置短信模板号"
    params = {
        "AccessKeyId": c["ak_id"], "Action": "SendSms", "Format": "JSON",
        "PhoneNumbers": phone, "RegionId": "cn-hangzhou",
        "SignName": c["sign"], "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": uuid.uuid4().hex, "SignatureVersion": "1.0",
        "TemplateCode": tpl, "TemplateParam": json.dumps(param, ensure_ascii=False),
        "Timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "Version": "2017-05-25",
    }
    try:
        with urllib.request.urlopen(_ali_sign(params, _s("sms_ali_secret")), timeout=TIMEOUT) as r:
            raw = r.read().decode("utf-8", "replace")
        obj = json.loads(raw) if raw.strip().startswith("{") else {}
        ok = obj.get("Code") == "OK"
        return ok, str(r.status), obj.get("Message") or raw[:200]
    except urllib.error.HTTPError as ex:
        try:
            detail = ex.read().decode("utf-8", "replace")[:200]
        except Exception:
            detail = ""
        return False, str(ex.code), detail or ("HTTP %s" % ex.code)
    except Exception as ex:
        return False, "error", str(ex)[:200]


def _send_tencent(phone, scene, code, text):
    c = config()["tencent"]
    tpl = c["tpl_alert"] if scene == "alert" else c["tpl_code"]
    if not tpl:
        return False, "missing", "没有配置短信模板号"
    params = [""] if scene == "alert" else [code]
    payload = {
        "PhoneNumberSet": ["+86" + phone],
        "SmsSdkAppId": c["sdk_app_id"],
        "SignName": c["sign"],
        "TemplateId": tpl,
        "TemplateParamSet": params,
    }
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    host, service = "sms.tencentcloudapi.com", "sms"
    ts = int(time.time())
    date = datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
    ct = "application/json; charset=utf-8"
    canon_req = "\n".join(["POST", "/", "", "content-type:%s\nhost:%s\n" % (ct, host),
                           "content-type;host", hashlib.sha256(body.encode()).hexdigest()])
    scope = "%s/%s/tc3_request" % (date, service)
    sts = "\n".join(["TC3-HMAC-SHA256", str(ts), scope,
                     hashlib.sha256(canon_req.encode()).hexdigest()])

    def _h(key, msg):
        return hmac.new(key, msg.encode(), hashlib.sha256).digest()

    k = _h(("TC3" + _s("sms_tx_key")).encode(), date)
    k = _h(k, service)
    k = _h(k, "tc3_request")
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    auth = ("TC3-HMAC-SHA256 Credential=%s/%s, SignedHeaders=content-type;host, Signature=%s"
            % (c["secret_id"], scope, sig))
    req = urllib.request.Request("https://%s/" % host, data=body.encode(), method="POST")
    for h, v in (("Content-Type", ct), ("Host", host), ("X-TC-Action", "SendSms"),
                 ("X-TC-Timestamp", str(ts)), ("X-TC-Version", "2021-01-11"),
                 ("X-TC-Region", "ap-guangzhou"), ("Authorization", auth)):
        req.add_header(h, v)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read().decode("utf-8", "replace")
        obj = json.loads(raw).get("Response", {})
        ok = not obj.get("Error")
        return ok, "200", obj.get("Error", {}).get("Message") or raw[:200]
    except urllib.error.HTTPError as ex:
        try:
            detail = ex.read().decode("utf-8", "replace")[:200]
        except Exception:
            detail = ""
        return False, str(ex.code), detail or ("HTTP %s" % ex.code)
    except Exception as ex:
        return False, "error", str(ex)[:200]


def _send_custom(phone, scene, code, text):
    c = config()["custom"]
    payload = {"phone": phone, "scene": scene, "code": code, "text": text}
    req = urllib.request.Request(c["url"],
                                 data=json.dumps(payload, ensure_ascii=False).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    if c["token"]:
        req.add_header("Authorization", "Bearer " + c["token"])
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read().decode("utf-8", "replace")[:200]
        return 200 <= r.status < 300, str(r.status), raw
    except urllib.error.HTTPError as ex:
        try:
            detail = ex.read().decode("utf-8", "replace")[:200]
        except Exception:
            detail = ""
        return False, str(ex.code), detail or ("HTTP %s" % ex.code)
    except Exception as ex:
        return False, "error", str(ex)[:200]


def _dispatch(phone, scene, code, text=""):
    p = config()["provider"]
    if p == "aliyun":
        return _send_aliyun(phone, scene, code, text)
    if p == "tencent":
        return _send_tencent(phone, scene, code, text)
    if p == "custom":
        return _send_custom(phone, scene, code, text)
    return False, "none", "还没有配置短信网关"


def _log_send(phone, scene, channel, ok, st, msg, ip=""):
    db.ex("INSERT INTO sms_sends(phone,scene,channel,ok,status,message,ip,created_at)"
          " VALUES(?,?,?,?,?,?,?,?)",
          (_mask(phone), scene, channel, 1 if ok else 0, str(st)[:20], (msg or "")[:300],
           (ip or "")[:40], db.now()))


def _mask(phone):
    p = normalize(phone)
    return p[:3] + "****" + p[-4:] if len(p) == 11 else p


def send_code(phone, scene, ip=""):
    """发一条验证码。成功返回 dev_code 的场景只有"没配网关"的本地自测模式。"""
    if scene not in SCENES:
        return {"ok": False, "error": "场景无效"}
    ok, reason, phone = check_phone(phone)
    if not ok:
        return {"ok": False, "error": reason}
    can, wait = rate_limit(phone, ip)
    if not can:
        if wait:
            return {"ok": False, "error": "发得太快了，%d 秒后再试" % wait}
        return {"ok": False, "error": "这个手机号今天收的验证码太多了，请明天再试或联系社区"}
    if config()["check_online"]:
        st = number_status(phone)
        if st.get("checked") and not st.get("ok"):
            return {"ok": False, "error": "这个号码现在不是正常在网状态（%s），请换一个常用手机号" % st.get("state")}

    code = "".join(secrets.choice("0123456789") for _ in range(CODE_LEN))
    h = hashlib.sha256(code.encode()).hexdigest()
    now = datetime.now()
    db.ex("INSERT INTO sms_codes(phone,scene,code_hash,created_at,expires_at,attempts,ip)"
          " VALUES(?,?,?,?,?,0,?)",
          (phone, scene, h, now.strftime("%Y-%m-%d %H:%M:%S"),
           (now + timedelta(seconds=CODE_TTL)).strftime("%Y-%m-%d %H:%M:%S"), (ip or "")[:40]))

    if provider_ready():
        ok, st, msg = _dispatch(phone, scene, code)
        _log_send(phone, scene, config()["provider"], ok, st, msg, ip)
        if not ok:
            return {"ok": False, "error": "短信没发出去：%s" % (msg or st), "channel": "gateway"}
        return {"ok": True, "channel": "gateway", "ttl": CODE_TTL,
                "message": "验证码已发送到 %s，5 分钟内有效" % _mask(phone)}

    # 没配网关：码只打到服务端窗口，方便本机自测；界面会明确提示"未接入网关"
    print("[sms] 未配置短信网关，%s 的%s验证码：%s" % (_mask(phone), SCENES[scene], code), flush=True)
    _log_send(phone, scene, "console", True, "console", "未配置网关，验证码输出到服务端窗口", ip)
    return {"ok": True, "channel": "console", "ttl": CODE_TTL, "dev_code": code,
            "message": "还没有接入短信网关，验证码已打印在服务端窗口（本地自测模式）"}


def verify_code(phone, scene, code):
    """校验并消费验证码。返回 (ok, error)。"""
    ok, reason, phone = check_phone(phone)
    if not ok:
        return False, reason
    code = re.sub(r"\D", "", str(code or ""))
    if len(code) != CODE_LEN:
        return False, "请填写 %d 位短信验证码" % CODE_LEN
    row = db.q1("SELECT * FROM sms_codes WHERE phone=? AND scene=? AND used_at IS NULL"
                " ORDER BY id DESC LIMIT 1", (phone, scene))
    if not row:
        return False, "请先获取验证码"
    if row["expires_at"] < db.now():
        return False, "验证码已过期，请重新获取"
    if row["attempts"] >= MAX_ATTEMPTS:
        return False, "这条验证码错太多次了，请重新获取"
    db.ex("UPDATE sms_codes SET attempts=attempts+1 WHERE id=?", (row["id"],))
    if not hmac.compare_digest(hashlib.sha256(code.encode()).hexdigest(), row["code_hash"]):
        left = MAX_ATTEMPTS - row["attempts"] - 1
        return False, "验证码不对，还可以再试 %d 次" % left if left > 0 else "验证码不对，请重新获取"
    db.ex("UPDATE sms_codes SET used_at=? WHERE id=?", (db.now(), row["id"]))
    return True, ""


# ---------------- 在网状态（可选，需要阿里云号码百科） ----------------

def number_status(phone):
    """调用阿里云号码百科判断是否正常在网。

    配了才调用，调用失败不影响注册（宁可放过去，也不能因为第三方抽风把人挡在外面），
    但会把失败原因打到日志里。
    """
    ak, secret = _s("sms_ali_ak"), _s("sms_ali_secret")
    if not (ak and secret):
        return {"checked": False, "reason": "未配置 AccessKey，跳过在网检测"}
    params = {
        "AccessKeyId": ak, "Action": "PhoneNumberStatusForSms", "AuthCode": "",
        "Format": "JSON", "Mask": "NORMAL", "RegionId": "cn-hangzhou",
        "SignatureMethod": "HMAC-SHA1", "SignatureNonce": uuid.uuid4().hex,
        "SignatureVersion": "1.0", "Timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "Version": "2019-01-01",
    }
    params["InputNumber"] = phone
    params["AuthCode"] = ""
    try:
        with urllib.request.urlopen(_ali_sign(params, secret), timeout=TIMEOUT) as r:
            obj = json.loads(r.read().decode("utf-8", "replace"))
        st = (obj.get("Data") or {}).get("Status") or ""
        return {"checked": True, "ok": st.upper() in ("NORMAL", "REAL"), "state": st or obj.get("Message")}
    except Exception as ex:
        print("[sms] 在网状态查询失败：%s" % ex, flush=True)
        return {"checked": False, "reason": str(ex)[:120]}


# ---------------- 告警短信（给紧急联系人） ----------------

def send_alert(phone, elder_name, reason, ip="", alert_id=None):
    """紧急求助时给某个联系人发一条短信。失败也留痕，返回结果给调度器。"""
    ok, reason_txt, p = check_phone(phone)
    if not ok:
        _log_send(phone, "alert", config()["provider"] or "none", False, "bad-number", reason_txt, ip)
        return {"ok": False, "error": reason_txt}
    text = ("【安语紧急求助】%s 触发求助：%s。请立即回电或前往查看。"
            % (elder_name or "老人", (reason or "求助")[:40]))
    if not provider_ready():
        print("[sms] 未配置网关，应发给 %s 的告警短信：%s" % (_mask(p), text), flush=True)
        _log_send(p, "alert", "console", False, "no-gateway", text, ip)
        return {"ok": False, "error": "未接入短信网关，告警短信未发出"}
    ok2, st, msg = _dispatch(p, "alert", "", text)
    _log_send(p, "alert", config()["provider"], ok2, st, msg, ip)
    return {"ok": ok2, "error": "" if ok2 else (msg or st)}


def test(phone):
    ok, reason, p = check_phone(phone)
    if not ok:
        return {"ok": False, "message": reason}
    if not provider_ready():
        return {"ok": False, "message": "还没有配置短信网关（或配置不完整）"}
    code = "123456"
    ok2, st, msg = _dispatch(p, "test", code)
    _log_send(p, "test", config()["provider"], ok2, st, msg)
    return {"ok": ok2, "message": "发送成功" if ok2 else (msg or st)}


def recent(limit=12):
    return db.q("SELECT * FROM sms_sends ORDER BY id DESC LIMIT ?", (limit,))
