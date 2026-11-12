"""对话智能：真实大模型（OpenAI 兼容接口）+ 本地意图引擎兜底。

大模型只负责“听懂 + 说话”，一切写库动作都由服务端执行并做权限校验，
避免模型直接改数据。
"""
import json
import re
import urllib.error
import urllib.request
from datetime import datetime

import config
import db
import service

SYSTEM_PROMPT = """你是「安语」，一位住在老人家里、通过音箱和手机陪护的AI助手。服务对象是独居或空巢老人。

说话要求：
1. 用口语，短句，一次只说一件事，一般不超过60个字；不用markdown、不用列表、不用专业术语。
2. 称呼对方为「{display}」。语气温和、稳，不说教、不过度热情、不卖萌。
3. 涉及医疗时只做提醒和陪伴，绝不诊断、不判断病情、不建议用药剂量。
   对方描述身体不适时，必须先调用 report_symptom 真的通知家属，再说「我告诉家人了」；
   没有调用动作就绝不能声称「已经通知」「已经记下」，说过就要做到。
4. 遇到胸痛、呼吸困难、意识不清、大出血、摔倒起不来，先安抚并立刻调用 sos 动作。
5. 不要编造数据。血压、用药、家人信息只能用下面提供的事实；不知道就说不知道。

你可以调用这些动作（action），由系统真正执行：
- confirm_med：老人表示已经吃过药，参数 {{"med_id": 可选整数}}
- record_vital：老人报了血压，参数 {{"sys": 整数, "dia": 整数, "pulse": 可选整数}}
- report_symptom：老人说不舒服但还不到叫人上门的程度（头疼、头晕、心慌、腿疼、没胃口、睡不着等），参数 {{"symptom": "用老人自己的说法，简短", "severity": "normal"}}
- sos：紧急求助，胸痛、呼吸困难、摔倒起不来、意识不清等，参数 {{"reason": "简短原因"}}
- list_meds：老人问今天还有什么药
- read_messages：老人想听家人留言
- call_family：老人想给家人打电话
- none：不需要执行任何动作

当前事实（由系统提供，请以此为准）：
{context}

只输出一个 JSON 对象，不要输出任何其它文字，格式：
{{"reply": "要对老人说的话", "action": {{"name": "动作名", "args": {{}}}}}}
如果不需要动作，action 用 {{"name": "none", "args": {{}}}}。
"""


# ---------------- 配置 ----------------

def llm_settings():
    cfg = config.get()["llm"]
    key = db.setting_get("llm_api_key") or cfg.get("api_key") or ""
    base = db.setting_get("llm_base_url") or cfg.get("base_url") or ""
    model = db.setting_get("llm_model") or cfg.get("model") or ""
    return {
        "api_key": key,
        "base_url": base.rstrip("/"),
        "model": model,
        "temperature": cfg.get("temperature", 0.3),
        "timeout": cfg.get("timeout", 25),
    }


def set_llm(api_key=None, base_url=None, model=None):
    if api_key is not None:
        db.setting_set("llm_api_key", api_key.strip())
    if base_url is not None and base_url.strip():
        db.setting_set("llm_base_url", base_url.strip())
    if model is not None and model.strip():
        db.setting_set("llm_model", model.strip())


LAST_ERROR = {"code": "", "message": "", "at": ""}


def _remember_error(code, message=""):
    LAST_ERROR.update({"code": code, "message": message or "", "at": db.now()})


def clear_llm():
    for k in ("llm_api_key", "llm_base_url", "llm_model"):
        db.setting_set(k, "")
    LAST_ERROR.update({"code": "", "message": "", "at": ""})


def status():
    s = llm_settings()
    key = s["api_key"]
    configured = bool(key and s["base_url"] and s["model"])
    return {
        "configured": configured,
        "model": s["model"],
        "base_url": s["base_url"],
        "key_hint": (key[:6] + "..." + key[-4:]) if len(key) > 12 else ("已配置" if key else ""),
        "last_error": dict(LAST_ERROR) if not configured or LAST_ERROR["code"] else None,
    }


# 常见失败原因，直接翻成人话
ERROR_HINTS = {
    "401": "Key 不正确或已失效，请到 DeepSeek 控制台重新生成",
    "402": "账户余额不足，请先充值",
    "403": "这个 Key 没有权限调用该模型",
    "404": "模型名或接口地址不对（DeepSeek 应为 https://api.deepseek.com/v1）",
    "422": "请求参数被拒绝，通常是模型名写错",
    "429": "请求太频繁或额度用尽，稍后再试",
    "500": "模型服务内部错误，稍后再试",
    "503": "模型服务繁忙，稍后再试",
}


# ---------------- 上下文 ----------------

def call_json(system, user, max_tokens=600, temperature=0.2):
    """给其它模块用的通用 JSON 调用（复用同一套配置、重试与错误记录）。"""
    s = llm_settings()
    if not (s["api_key"] and s["base_url"] and s["model"]):
        return None, "not-configured"
    body = {
        "model": s["model"],
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": max_tokens,
    }
    try:
        data = _post_llm({"url": s["base_url"] + "/chat/completions",
                          "key": s["api_key"], "body": body}, s["timeout"])
        obj = _parse_json(data["choices"][0]["message"]["content"])
        if obj is None:
            retry = {k: v for k, v in body.items() if k != "response_format"}
            data = _post_llm({"url": s["base_url"] + "/chat/completions",
                              "key": s["api_key"], "body": retry}, s["timeout"])
            obj = _parse_json(data["choices"][0]["message"]["content"])
        if obj is None:
            _remember_error("bad-format", "值守模型返回的不是 JSON")
            return None, "bad-format"
        LAST_ERROR.update({"code": "", "message": "", "at": ""})
        return obj, "llm"
    except urllib.error.HTTPError as ex:
        hint = ERROR_HINTS.get(str(ex.code), "")
        _remember_error("http-%s" % ex.code, hint)
        return None, "http-%s" % ex.code
    except Exception as ex:
        _remember_error("error", str(ex)[:120])
        return None, "error"


def build_context(elder_id):
    e = service.elder(elder_id) or {}
    prog = service.meds_today(elder_id)
    parts = []
    parts.append("老人：%s，%s岁，住址 %s。" % (e.get("name"), e.get("age") or "未知", e.get("address") or "未知"))
    if e.get("conditions"):
        parts.append("基础病：%s。过敏：%s。" % (e["conditions"], e.get("allergies") or "无记录"))
    if prog:
        seg = []
        for m in prog:
            label = {"taken": "已确认服用", "due": "到点未确认", "late": "已过时未确认",
                     "upcoming": "还没到时间"}[m["state"]]
            seg.append("%s（%s，%s）%s" % (m["name"], m["time"], m["meal"] or "", label))
        parts.append("今天用药：" + "；".join(seg) + "。")
    else:
        parts.append("今天没有登记用药。")
    v = service.latest_vital(elder_id)
    if v:
        parts.append("最近一次血压：%d/%d，脉搏 %s，时间 %s。" %
                     (v["sys"], v["dia"], v.get("pulse") or "未记录", v["measured_at"]))
    else:
        parts.append("还没有血压记录。")
    contact = db.q1("SELECT name,relation,phone FROM users WHERE elder_id=? AND role='family' LIMIT 1",
                    (elder_id,))
    if contact:
        parts.append("家人：%s（%s）。" % (contact["name"], contact.get("relation") or "家属"))
    c = service.consents(elder_id)
    if not c["share_health"]:
        parts.append("注意：老人已关闭健康数据共享，不要主动报血压细节。")
    return "\n".join(parts)


# ---------------- 动作执行 ----------------

def _resolve_med(elder_id, med_id=None):
    if med_id:
        m = db.q1("SELECT * FROM meds WHERE id=? AND elder_id=?", (med_id, elder_id))
        return m["id"] if m else None
    prog = service.meds_today(elder_id)
    cand = [m for m in prog if m["state"] in ("due", "late")] or prog
    cand.sort(key=lambda m: m["time"])
    return cand[0]["id"] if cand else None


def perform_action(elder_id, name, args=None, actor="老人"):
    args = args or {}
    if name in (None, "", "none"):
        return {"ok": True, "kind": "none"}

    if name == "confirm_med":
        med_id = _resolve_med(elder_id, args.get("med_id"))
        if not med_id:
            return {"ok": False, "kind": "confirm_med", "error": "今天没有待确认的用药"}
        r = service.confirm_med(elder_id, med_id, source="voice")
        if r["ok"]:
            r["kind"] = "confirm_med"
        return r

    if name == "record_vital":
        try:
            sys_ = int(args.get("sys")); dia = int(args.get("dia"))
        except Exception:
            return {"ok": False, "kind": "record_vital", "error": "血压数值不完整"}
        pulse = args.get("pulse")
        r = service.add_vital(elder_id, sys_, dia, int(pulse) if pulse else None, source="voice")
        r["kind"] = "record_vital"
        return r

    if name == "report_symptom":
        r = service.add_symptom(elder_id, args.get("symptom") or args.get("text") or "",
                                args.get("severity"), source="voice")
        if r.get("ok"):
            c = db.q1("SELECT name FROM users WHERE elder_id=? AND role='family' LIMIT 1",
                      (elder_id,))
            r["notified"] = (c or {}).get("name") or "家属"
        return r

    if name == "sos":
        reason = (args.get("reason") or "语音求助").strip()[:80]
        aid = service.create_alert(elder_id, "sos", "紧急求助：" + reason,
                                   "老人通过语音触发求助。", source="voice")
        # 紧急求助同时留一条症状记录，事后复盘能看到老人当时怎么说的
        try:
            sid = db.ex("INSERT INTO symptoms(elder_id,text,severity,alert_id,at,source)"
                        " VALUES(?,?,?,?,?,?)",
                        (elder_id, reason, "high", aid, db.now(), "sos"))
        except Exception:
            sid = None
        r = service.report(elder_id, 1)
        return {"ok": True, "kind": "sos", "alert_id": aid, "reason": reason}

    if name == "list_meds":
        return {"ok": True, "kind": "list_meds", "meds": service.meds_today(elder_id)}

    if name == "read_messages":
        msgs = service.list_messages(elder_id, 3)
        service.mark_messages_read(elder_id)
        return {"ok": True, "kind": "read_messages", "messages": msgs}

    if name == "call_family":
        c = db.q1("SELECT name,phone FROM users WHERE elder_id=? AND role='family' LIMIT 1",
                  (elder_id,))
        return {"ok": True, "kind": "call_family",
                "contact": {"name": (c or {}).get("name"), "phone": (c or {}).get("phone")}}

    return {"ok": False, "kind": name, "error": "未知动作"}


# ---------------- 大模型调用 ----------------

def _post_llm(payload, timeout):
    req = urllib.request.Request(
        payload["url"],
        data=json.dumps(payload["body"]).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + payload["key"],
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_json(text):
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


def ask_llm(elder_id, text):
    s = llm_settings()
    if not (s["api_key"] and s["base_url"] and s["model"]):
        return None, "not-configured"
    context = build_context(elder_id)
    e = service.elder(elder_id) or {}
    sys_msg = SYSTEM_PROMPT.format(display=e.get("display") or e.get("name") or "您",
                                   context=context)
    body = {
        "model": s["model"],
        "temperature": s["temperature"],
        "messages": [
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": text},
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 400,
    }
    def attempt(payload_body):
        payload = {"url": s["base_url"] + "/chat/completions", "key": s["api_key"],
                   "body": payload_body}
        data = _post_llm(payload, s["timeout"])
        content = data["choices"][0]["message"]["content"]
        return _parse_json(content)

    try:
        obj = attempt(body)
        if not obj or "reply" not in obj:
            # 有的模型不支持 response_format，去掉再试一次
            retry_body = {k: v for k, v in body.items() if k != "response_format"}
            if retry_body != body:
                obj = attempt(retry_body)
        if not obj or "reply" not in obj:
            _remember_error("bad-format", "模型返回的不是约定格式")
            return None, "bad-format"
        LAST_ERROR.update({"code": "", "message": "", "at": ""})
        return obj, "llm"
    except urllib.error.HTTPError as ex:
        detail = ""
        try:
            raw = ex.read().decode("utf-8", "replace")
            obj = json.loads(raw)
            detail = ((obj.get("error") or {}).get("message") or raw)[:200]
        except Exception:
            pass
        # 400 且与 response_format 有关：去掉该参数重试一次
        if ex.code == 400 and ("response_format" in detail.lower() or "json" in detail.lower()):
            try:
                retry_body = {k: v for k, v in body.items() if k != "response_format"}
                obj = attempt(retry_body)
                if obj and "reply" in obj:
                    LAST_ERROR.update({"code": "", "message": "", "at": ""})
                    return obj, "llm"
            except Exception:
                pass
        hint = ERROR_HINTS.get(str(ex.code), "")
        _remember_error("http-%s" % ex.code, (hint + " " + detail).strip())
        print("[ai] 大模型 HTTP %s %s" % (ex.code, detail))
        return None, "http-%s" % ex.code
    except urllib.error.URLError as ex:
        _remember_error("network", "连不上模型服务：%s" % (ex.reason,))
        print("[ai] 连接失败：%s" % ex.reason)
        return None, "network"
    except Exception as ex:
        _remember_error("error", str(ex)[:160])
        print("[ai] 大模型调用失败：%s" % ex)
        return None, "error"


# ---------------- 本地意图引擎（兜底，也是没配 Key 时的能力） ----------------

def local_intent(elder_id, text):
    """返回 (reply, action_result)。没有配置大模型时的真实可用能力。"""
    t = (text or "").strip()
    e = service.elder(elder_id) or {}
    disp = e.get("display") or e.get("name") or "您"
    none = {"ok": True, "kind": "none"}

    m = re.search(r"血压\D*(\d{2,3})\D+(\d{2,3})", t)
    if m:
        sys_, dia = int(m.group(1)), int(m.group(2))
        r = perform_action(elder_id, "record_vital", {"sys": sys_, "dia": dia})
        if r.get("ok"):
            return "好，%d 比 %d，我记上了。要是不舒服，随时跟我说。" % (sys_, dia), r
        return "这两个数我没记上，您再说一次，比如「血压 135 85」。", r

    if re.search(r"救命|摔|起不来|胸口|胸痛|喘不上气|呼吸困难|晕倒", t):
        r = perform_action(elder_id, "sos", {"reason": t[:30]})
        return "别急，我这就叫人来。您先坐着别动，我陪着您。", r

    if re.search(r"头疼|头痛|头晕|心慌|胸闷|没胃口|不想吃|睡不着|失眠|腿疼|腰疼|关节疼|不舒服|难受|乏力|没力气", t):
        r = service.add_symptom(elder_id, t[:40], None, source="voice")
        if r.get("ok"):
            return "我记下了，也告诉%s了，让他们回个电话问问您。" % r.get("notified", "家属"), r
        return "您再说一遍哪儿不舒服？", r

    if re.search(r"吃(过|了)|药吃了|吃完", t):
        r = perform_action(elder_id, "confirm_med", {})
        if r.get("ok"):
            return "好，记上了。", r
        return "今天没有等您确认的药了。", r

    if re.search(r"还有什么药|吃什么药|药呢", t):
        meds = service.meds_today(elder_id)
        pend = [x for x in meds if x["state"] != "taken"]
        if not pend:
            return "今天的药都吃完了。", none
        nxt = pend[0]
        return "下一次是 %s 的%s，%s。" % (nxt["time"], nxt["name"], nxt["meal"] or ""), none

    if re.search(r"留言|闺女说|儿子说|家人说", t):
        msgs = service.list_messages(elder_id, 1)
        service.mark_messages_read(elder_id)
        if msgs:
            mm = msgs[0]
            return "%s留的：%s" % (mm["from_name"] or "家人", mm["text"]), none
        return "还没有新留言。", none

    if re.search(r"打给|打电话|找闺女|找儿子|想闺女|想儿子", t):
        r = perform_action(elder_id, "call_family", {})
        c = r.get("contact") or {}
        if c.get("phone"):
            return "好，我给您拨%s的电话。" % c["name"], r
        return "还没登记家人的电话，让家属在后台补一下吧。", r

    if re.search(r"几点|几号|星期", t):
        n = datetime.now()
        wd = "一二三四五六日"[n.weekday()]
        return "现在 %d 点 %d 分，%d 月 %d 日，星期%s。" % (n.hour, n.minute, n.month, n.day, wd), none

    if re.search(r"孤单|闷|没意思|睡不着", t):
        return "%s，我陪您说说话。今天有没有哪儿不舒服？" % disp, none

    if re.search(r"谢谢|知道了|好的", t):
        return "哎，好。", none

    return "这个我还听不太懂。您可以说「我吃过了」「血压 135 85」「打给女儿」，或者按红色按钮叫人。", none


# ---------------- 统一入口 ----------------

def chat(elder_id, text):
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "没有听到内容"}
    if len(text) > 500:
        text = text[:500]

    obj, mode = ask_llm(elder_id, text)
    action_result = {"ok": True, "kind": "none"}
    if obj:
        reply = str(obj.get("reply") or "").strip()
        act = obj.get("action") or {}
        action_result = perform_action(elder_id, act.get("name"), act.get("args") or {})
        if not reply:
            reply = "嗯，我在。"
    else:
        reply, action_result = local_intent(elder_id, text)
        mode = "local" if mode == "not-configured" else "local-fallback"

    db.ex("INSERT INTO chats(elder_id,role,text,ai_mode,created_at) VALUES(?,?,?,?,?)",
          (elder_id, "user", text, mode, db.now()))
    db.ex("INSERT INTO chats(elder_id,role,text,ai_mode,created_at) VALUES(?,?,?,?,?)",
          (elder_id, "assistant", reply, mode, db.now()))

    out = {"ok": True, "reply": reply, "ai_mode": mode, "action": action_result}
    if action_result.get("kind") == "record_vital" and action_result.get("ok"):
        out["flash"] = "vital"
    if action_result.get("kind") == "confirm_med" and action_result.get("ok"):
        out["flash"] = "med"
    if action_result.get("kind") == "sos":
        out["flash"] = "sos"
    return out
