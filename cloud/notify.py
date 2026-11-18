"""告警通知：把求助真正推到人身上，而不是只留在网页里。

支持四类通道：
- 企业微信群机器人 / 钉钉群机器人（填 webhook 即可，免费、最快）
- Server酱 / PushPlus（推到微信，填 token 即可）
- 自定义 webhook（对接你自己的短信/呼叫网关）
- 阿里云语音通知（真的打电话，需要企业账号 + 已审核的 TTS 模板）

设计原则：
- 任一通道失败不影响其它通道，结果全部写 notify_logs，可回看；
- 不假装成功：没配的通道显示"未配置"，失败的把服务端原文带出来；
- 拨打 110/120 需要资质与运营商专线，本系统只做"通知到人"，不做谎称报警。
"""
import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime

import db

TIMEOUT = 10

# key -> (显示名, 类型, 配置说明)
CHANNELS = {
    "wecom": ("企业微信群机器人", "webhook", "群设置 → 群机器人 → 添加 → 复制 Webhook 地址"),
    "dingtalk": ("钉钉群机器人", "webhook", "群设置 → 智能群助手 → 添加机器人 → 复制 Webhook"),
    "serverchan": ("Server酱（推微信）", "token", "sct.ftqq.com 登录后复制 SendKey（形如 SCT...）"),
    "pushplus": ("PushPlus（推微信）", "token", "pushplus.plus 登录后复制 token"),
    "custom": ("自定义 Webhook", "webhook", "接收 JSON：{title, text, level, elder, alert_id}"),
    "aliyun_voice": ("阿里云语音通知（打电话）", "voice", "需开通语音通知服务，并有一个审核通过的 TTS 模板"),
}


# ---------------- 配置 ----------------

def _key(ch):
    return "notify_" + ch


def get_config():
    cfg = {}
    for ch, (label, kind, hint) in CHANNELS.items():
        cfg[ch] = {
            "label": label,
            "kind": kind,
            "hint": hint,
            "value": db.setting_get(_key(ch)) or "",
            "configured": bool((db.setting_get(_key(ch)) or "").strip()),
        }
    cfg["_voice"] = {
        "ak_id": db.setting_get("voice_ak_id") or "",
        "ak_secret_set": bool(db.setting_get("voice_ak_secret")),
        "called": db.setting_get("voice_called") or "",
        "tts_code": db.setting_get("voice_tts_code") or "",
    }
    return cfg


def set_config(ch, value):
    if ch not in CHANNELS:
        return {"ok": False, "error": "未知通道"}
    db.setting_set(_key(ch), (value or "").strip())
    return {"ok": True, "configured": bool((value or "").strip())}


def set_voice(ak_id=None, ak_secret=None, called=None, tts_code=None):
    if ak_id is not None:
        db.setting_set("voice_ak_id", ak_id.strip())
    if ak_secret:
        db.setting_set("voice_ak_secret", ak_secret.strip())
    if called is not None:
        db.setting_set("voice_called", called.strip())
    if tts_code is not None:
        db.setting_set("voice_tts_code", tts_code.strip())
    return get_config()["_voice"]


def active_channels():
    out = []
    for ch in CHANNELS:
        if (db.setting_get(_key(ch)) or "").strip():
            out.append(ch)
    if voice_ready():
        out.append("aliyun_voice")
    return out


def voice_ready():
    return all((db.setting_get(k) or "").strip() for k in
               ("voice_ak_id", "voice_ak_secret", "voice_called", "voice_tts_code"))


# ---------------- 发送 ----------------

def _post(url, payload, headers=None):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read().decode("utf-8", "replace")
        return resp.status, raw[:300]


def _log(alert_id, channel, target, ok, status, message):
    db.ex("INSERT INTO notify_logs(alert_id,channel,target,ok,status,message,created_at)"
          " VALUES(?,?,?,?,?,?,?)",
          (alert_id, channel, target[:80], 1 if ok else 0, str(status)[:20],
           (message or "")[:300], db.now()))


def build_text(alert, elder):
    who = (elder or {}).get("display") or (elder or {}).get("name") or "老人"
    level = alert.get("level") or "warn"
    head = "【紧急求助】" if level == "sos" else "【安语提醒】"
    title = (alert.get("title") or "").strip()
    for pre in ("紧急求助：", "紧急求助:", "【紧急求助】"):
        if title.startswith(pre):
            title = title[len(pre):]
            break
    lines = [
        head + title,
        "老人：%s（%s 岁）" % (who, (elder or {}).get("age") or "?"),
        "住址：%s" % ((elder or {}).get("address") or "未登记"),
        "时间：%s" % (alert.get("raised_at") or db.now()),
    ]
    if (elder or {}).get("conditions"):
        lines.append("基础病：%s" % elder["conditions"])
    if (elder or {}).get("allergies"):
        lines.append("过敏：%s" % elder["allergies"])
    if alert.get("detail"):
        lines.append("情况：%s" % alert["detail"])
    lines.append("请立即回电或前往查看。" if level == "sos" else "请留意并回电确认。")
    return "\n".join(lines)


def send(alert, elder, alert_id=None):
    """把一条告警推到所有已配置通道，返回每个通道的结果。"""
    aid = alert_id or alert.get("id")
    text = build_text(alert, elder)
    title = alert.get("title") or "安语告警"
    results = []

    wecom = (db.setting_get(_key("wecom")) or "").strip()
    if wecom:
        results.append(_do("wecom", wecom, lambda: _post(wecom, {
            "msgtype": "text", "text": {"content": text}}), aid))

    ding = (db.setting_get(_key("dingtalk")) or "").strip()
    if ding:
        results.append(_do("dingtalk", ding, lambda: _post(ding, {
            "msgtype": "text", "text": {"content": text}}), aid))

    sc = (db.setting_get(_key("serverchan")) or "").strip()
    if sc:
        url = "https://sctapi.ftqq.com/%s.send" % sc if sc.startswith("SCT") else sc
        results.append(_do("serverchan", url, lambda: _post(url, {
            "title": title[:32], "desp": text.replace("\n", "\n\n")}), aid))

    pp = (db.setting_get(_key("pushplus")) or "").strip()
    if pp:
        url = "https://www.pushplus.plus/send"
        results.append(_do("pushplus", url, lambda: _post(url, {
            "token": pp, "title": title[:32], "content": text.replace("\n", "<br>"),
            "template": "html"}), aid))

    custom = (db.setting_get(_key("custom")) or "").strip()
    if custom:
        results.append(_do("custom", custom, lambda: _post(custom, {
            "title": title, "text": text, "level": alert.get("level"),
            "elder": (elder or {}).get("display") or (elder or {}).get("name"),
            "alert_id": aid}), aid))

    if voice_ready() and (alert.get("level") == "sos"):
        results.append(_voice_call(alert, elder, aid))

    return results


def _do(channel, target, fn, aid):
    try:
        status, raw = fn()
        ok = 200 <= status < 300
        if ok:
            # 有些平台 HTTP 200 但 body 里是错误码，这里顺带识别
            low = raw.lower()
            if '"errcode":0' in low.replace(" ", "") or '"code":200' in low.replace(" ", "") \
                    or '"code":0' in low.replace(" ", "") or "success" in low:
                pass
            elif '"errcode"' in low and '"errcode":0' not in low.replace(" ", ""):
                ok = False
        _log(aid, channel, target, ok, status, raw)
        return {"channel": channel, "ok": ok, "status": status, "message": raw[:160]}
    except urllib.error.HTTPError as ex:
        detail = ""
        try:
            detail = ex.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        _log(aid, channel, target, False, ex.code, detail)
        return {"channel": channel, "ok": False, "status": ex.code,
                "message": detail or ("HTTP %s" % ex.code)}
    except Exception as ex:
        _log(aid, channel, target, False, "error", str(ex)[:200])
        return {"channel": channel, "ok": False, "status": "error", "message": str(ex)[:160]}


# ---------------- 电话外呼（阿里云语音通知） ----------------

def _pct(s):
    return urllib.parse.quote(str(s), safe="~")


def _aliyun_url(params, secret):
    items = sorted(params.items())
    canon = "&".join("%s=%s" % (_pct(k), _pct(v)) for k, v in items)
    string_to_sign = "GET&%2F&" + _pct(canon)
    sig = base64.b64encode(
        hmac.new((secret + "&").encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    return "https://dyvmsapi.aliyuncs.com/?Signature=%s&%s" % (_pct(sig), canon)


def _dial(phone, who, reason, times=1):
    """真正拨出去一通 TTS 电话。返回 (ok, status, raw)。"""
    ak = (db.setting_get("voice_ak_id") or "").strip()
    secret = (db.setting_get("voice_ak_secret") or "").strip()
    tts = (db.setting_get("voice_tts_code") or "").strip()
    if not (ak and secret and tts):
        return False, "not-configured", "没有配置语音外呼（需要 AccessKey 和 TTS 模板）"
    params = {
        "AccessKeyId": ak,
        "Action": "SingleCallByTts",
        "Format": "JSON",
        "RegionId": "cn-hangzhou",
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": uuid.uuid4().hex,
        "SignatureVersion": "1.0",
        "Timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "Version": "2017-05-25",
        "CalledNumber": phone,
        "TtsCode": tts,
        "TtsParam": json.dumps({"name": (who or "老人")[:10], "reason": (reason or "紧急求助")[:20]},
                               ensure_ascii=False),
        "PlayTimes": str(max(1, int(times))),
    }
    url = _aliyun_url(params, secret)
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")[:300]
        ok = '"Code":"OK"' in raw.replace(" ", "")
        return ok, str(resp.status), raw
    except urllib.error.HTTPError as ex:
        detail = ""
        try:
            detail = ex.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        return False, str(ex.code), detail or ("HTTP %s" % ex.code)
    except Exception as ex:
        return False, "error", str(ex)[:200]


def _voice_call(alert, elder, aid):
    """老的"打给固定号码"入口，保留给测试按钮用。"""
    called = (db.setting_get("voice_called") or "").strip()
    who = (elder or {}).get("display") or (elder or {}).get("name") or "老人"
    ok, status, raw = _dial(called, who, (alert.get("title") or "")[:20], times=2) \
        if called else (False, "missing", "没有填被叫号码")
    _log(aid, "aliyun_voice", called, ok, status, raw)
    return {"channel": "aliyun_voice", "ok": ok, "status": status, "message": raw[:160]}


def call_number(alert_id, elder_id, contact, stage, who, reason):
    """给一位紧急联系人拨电话，并把结果写进 call_logs（工单详情里能看到打了几次、通没通）。"""
    phone = (contact.get("phone") or "").strip()
    name = contact.get("name") or "家属"
    ok, status, raw = _dial(phone, who, reason, times=2 if stage >= 3 else 1)
    db.ex("INSERT INTO call_logs(alert_id,elder_id,phone,name,stage,ok,status,message,created_at)"
          " VALUES(?,?,?,?,?,?,?,?,?)",
          (alert_id, elder_id, phone, name, stage, 1 if ok else 0, str(status)[:20],
           (raw or "")[:200], db.now()))
    _log(alert_id, "voice_%d" % stage, phone[-4:] if len(phone) >= 4 else phone, ok, status, raw)
    print("[call] 第 %d 级外呼 %s（尾号 %s）：%s" %
          (stage, name, phone[-4:], "已拨出" if ok else raw[:60]), flush=True)
    return {"ok": ok, "status": status, "message": raw[:160], "name": name, "phone": phone}


def call_async(alert_id, elder_id, contact, stage, who, reason):
    import threading

    def run():
        try:
            call_number(alert_id, elder_id, contact, stage, who, reason)
        except Exception as ex:
            print("[call] 外呼失败：%s" % ex, flush=True)
    threading.Thread(target=run, name="anyu-call", daemon=True).start()


# ---------------- 短信通知（发给紧急联系人本人） ----------------

def sms_alert_async(alert_id, elder_id, title, detail=""):
    """给每位紧急联系人单独发短信：群消息可以没人看，短信会响。"""
    import threading

    def run():
        import sms
        rows = db.q("SELECT name,phone FROM elder_contacts WHERE elder_id=? AND can_call=1"
                    " ORDER BY priority, id", (elder_id,))
        e = db.q1("SELECT display,name FROM elders WHERE id=?", (elder_id,)) or {}
        who = e.get("display") or e.get("name") or "老人"
        reason = (title or "紧急求助").replace("紧急求助：", "")[:30]
        if not rows:
            _log(alert_id, "sms", "-", False, "no-contact", "没有紧急联系人，短信无处可发")
            return
        for r in rows:
            try:
                res = sms.send_alert(r["phone"], who, reason, alert_id=alert_id)
            except Exception as ex:
                res = {"ok": False, "error": str(ex)[:120]}
            _log(alert_id, "sms", (r["phone"] or "")[-4:], res.get("ok"),
                 "200" if res.get("ok") else "fail", res.get("error") or "已送达")
    threading.Thread(target=run, name="anyu-sms", daemon=True).start()



# ---------------- 测试 ----------------

def test_all():
    fake = {"id": 0, "level": "sos", "title": "通知通道测试",
            "detail": "这是一条测试消息，收到说明通道可用。", "raised_at": db.now()}
    elder = {"display": "测试老人", "age": 78, "address": "测试地址 1 号"}
    res = send(fake, elder, alert_id=None)
    if not res:
        return {"ok": False, "message": "还没有配置任何通道", "results": []}
    return {"ok": any(r["ok"] for r in res),
            "message": "；".join("%s：%s" % (r["channel"], "成功" if r["ok"] else r["message"][:60])
                                for r in res),
            "results": res}


def recent(limit=10):
    return db.q("SELECT * FROM notify_logs ORDER BY id DESC LIMIT ?", (limit,))


def summary():
    chans = active_channels()
    return {"channels": chans, "count": len(chans),
            "voice": voice_ready(), "last": recent(5)}


def send_async(alert, elder, alert_id=None):
    """别让外网慢请求卡住求助响应。"""
    import threading
    def run():
        try:
            send(alert, elder, alert_id)
        except Exception as ex:
            print("[notify] 发送失败：%s" % ex)
    threading.Thread(target=run, name="anyu-notify", daemon=True).start()
