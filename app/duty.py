"""AI 值守：来单自动接单，按模型给出的方案把工单走完，每一步都留痕。

设计边界（写死在代码里，不交给模型决定）：
- 紧急求助（sos）只自动接单并升级，**永不自动结案**——"人没事"必须由真人确认；
- 自动结案只允许出现在用药提醒、普通症状、设备类等可复核事项上；
- 模型不能直接改数据库，只能输出方案，动作由本模块逐条执行并写事件；
- 没接大模型时退化为规则值守，模式会在记录里标成 rule。
"""
import json
from datetime import datetime

import ai
import db
import service

AI_NAME = "AI 值守"
AI_USER = {"id": 0, "name": AI_NAME}

MIN_AGE_SEC = 3        # 工单至少存续 3 秒才接管，给真人留反应时间
MAX_PER_ROUND = 3      # 单轮最多处理几单，避免一次性刷完
ENABLED_KEY = "ai_duty"
SOS_CLOSE_KEY = "ai_duty_sos_close"

SYSTEM = """你是社区养老值守台的调度助手「AI 值守」。你会拿到一条刚产生的工单和这位老人的档案，请给出可执行的处置方案。

必须遵守：
1. 不诊断、不判断病情、不建议用药剂量；涉及医疗只写"建议就医/联系家庭医生"。
2. 不能承诺已经上门、已经打电话；你只能"留言、通知、建议"。
3. 紧急求助（sos）一律 close=false、on_site=true，并且要家属和社区值班同时知情。
4. 只有确实可以由系统自动闭环的事项才允许 close=true，例如：用药提醒已补发、家属已被通知、记录已归档。
5. 老人说不舒服但已按紧急处理时，close 必须为 false。
6. **严禁编造**电话号码、姓名、门牌号、亲属关系等任何未在档案里出现的信息。
   需要联系方式时只写"请家属联系社区""请联系家属"，不要自己造号码。

只输出一个 JSON 对象：
{
  "risk": "high|medium|low",
  "steps": ["处置动作，3～5 条，每条不超过 20 字"],
  "message_to_elder": "给老人留言，一句话，口语，不超过 40 字",
  "message_to_family": "给家属留言，一句话，说明情况和要做什么，不超过 50 字",
  "on_site": true/false,
  "close": true/false,
  "close_note": "close 为 true 时写清楚凭什么可以结案"
}"""


# ---------------- 开关 ----------------

def enabled():
    return (db.setting_get(ENABLED_KEY) or "0") == "1"


def set_enabled(on):
    db.setting_set(ENABLED_KEY, "1" if on else "0")
    return enabled()


def status():
    st = ai.status()
    return {
        "enabled": enabled(),
        "mode": "llm" if st["configured"] else "rule",
        "model": st["model"] if st["configured"] else "",
        "sos_auto_close": (db.setting_get(SOS_CLOSE_KEY) or "0") == "1",
        "pending": db.q1("SELECT COUNT(*) n FROM alerts WHERE status='pending'")["n"],
    }


# ---------------- 上下文 ----------------

def _context(alert):
    e = service.elder(alert["elder_id"]) or {}
    meds = []
    try:
        meds = [{"name": m["name"], "time": m["time"], "state": m["state"]}
                for m in service.meds_today(alert["elder_id"])]
    except Exception:
        pass
    vital = {}
    try:
        vital = service.latest_vital(alert["elder_id"]) or {}
    except Exception:
        pass
    last = None
    try:
        last = service.last_activity(alert["elder_id"])
    except Exception:
        pass
    return {
        "工单": {
            "编号": alert["id"],
            "级别": alert["level"],
            "标题": alert["title"],
            "详情": alert.get("detail") or "",
            "来源": alert.get("source") or "",
            "产生时间": alert["raised_at"],
        },
        "老人": {
            "称呼": e.get("display") or e.get("name"),
            "年龄": e.get("age"),
            "住址": e.get("address"),
            "基础病": e.get("conditions"),
            "过敏": e.get("allergies"),
            "所属社区": e.get("community"),
        },
        "今日用药": meds,
        "最近血压": {k: vital.get(k) for k in ("sys", "dia", "measured_at")} if vital else {},
        "最后活动": last,
    }


# ---------------- 方案 ----------------

def _clean(plan, alert):
    """把模型输出收敛成安全、可执行的结构。"""
    if not isinstance(plan, dict):
        return None
    risk = str(plan.get("risk") or "").lower()
    if risk not in ("high", "medium", "low"):
        risk = "high" if alert["level"] == "sos" else "medium"

    steps = plan.get("steps") or []
    if not isinstance(steps, list):
        steps = []
    steps = [str(s).strip()[:48] for s in steps if str(s).strip()][:5]

    close = bool(plan.get("close"))
    note = str(plan.get("close_note") or "").strip()[:80]

    # 确定性策略：不靠模型每次判断一致，按工单类别定死闭环规则
    close, note = _apply_policy(alert, close, note, bool(plan.get("on_site")))

    return {
        "risk": risk,
        "steps": steps,
        "message_to_elder": str(plan.get("message_to_elder") or "").strip()[:60],
        "message_to_family": str(plan.get("message_to_family") or "").strip()[:80],
        "on_site": bool(plan.get("on_site")),
        "close": close,
        "close_note": note,
    }


def _apply_policy(alert, close, note, on_site):
    """把"能不能自动结案"从模型手里收回来，按类别定规则。

    - 紧急求助：永远不自动结案（除非管理员显式打开 sos 自动结案开关）；
    - 用药提醒：属提醒类，自动闭环；
    - 长时间没动静：必须家属回电确认，不自动结案；
    - 其他（症状、设备等）：听模型判断，但要求有结案依据。
    """
    src = alert.get("source") or ""
    lvl = alert["level"]

    if lvl == "sos":
        if (db.setting_get(SOS_CLOSE_KEY) or "0") == "1" and on_site is False:
            return True, note or "紧急求助已按流程通知到位（管理员允许自动结案）"
        return False, ""

    if src == "med" and not on_site:
        return True, note or "已完成用药提醒补发与家属通知，属可自动闭环的提醒类工单"

    if src == "inactive":
        return False, ""

    if close and not note:
        return False, ""
    return close, note


def _rule_plan(alert):
    """没接大模型时的兜底：按来源给出保守方案。"""
    src = alert.get("source") or ""
    lvl = alert["level"]
    if lvl == "sos":
        return {
            "risk": "high", "steps": ["立即通知家属", "通知社区值班", "建议家属尽快回电或上门"],
            "message_to_elder": "我在，已经通知家人和社区，您先坐着别动。",
            "message_to_family": "老人刚发起紧急求助，请立刻回电确认情况。",
            "on_site": True, "close": False, "close_note": "",
        }
    if src == "med":
        return {
            "risk": "medium", "steps": ["核对今日用药计划", "给老人补发一次提醒", "通知家属回电确认"],
            "message_to_elder": "到点该吃药了，吃完跟我说一声。",
            "message_to_family": "老人这顿药还没确认，请回电提醒一下。",
            "on_site": False, "close": True, "close_note": "已补发提醒并通知家属，用药记录已归档",
        }
    if src == "symptom":
        return {
            "risk": "medium", "steps": ["记录症状原文", "通知家属回电", "持续不适建议联系家庭医生"],
            "message_to_elder": "记下了，已经告诉家人，他们待会儿给您回电话。",
            "message_to_family": "老人说不舒服，请回电问一下具体情况。",
            "on_site": False, "close": True, "close_note": "症状已记录并通知家属",
        }
    if src == "inactive":
        return {
            "risk": "medium", "steps": ["确认设备在线", "通知家属回电", "无回应则由社区上门"],
            "message_to_elder": "今天还没听见您说话，我在呢，有事叫我。",
            "message_to_family": "老人今天长时间没有交互，建议回电确认。",
            "on_site": False, "close": False, "close_note": "",
        }
    return {
        "risk": "medium", "steps": ["核实工单信息", "通知家属"],
        "message_to_elder": "", "message_to_family": "有一条新工单，请关注。",
        "on_site": False, "close": False, "close_note": "",
    }


def build_plan(alert):
    ctx = _context(alert)
    user = "工单与档案如下，请给处置方案：\n" + json.dumps(ctx, ensure_ascii=False)
    obj, mode = ai.call_json(SYSTEM, user)
    if mode == "llm":
        plan = _clean(obj, alert)
        if plan:
            return plan, "llm"
    return _rule_plan(alert), "rule"


# ---------------- 执行 ----------------

def _seconds_since(ts):
    try:
        return (datetime.now() - datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")).total_seconds()
    except Exception:
        return 0


def handle(alert):
    """接单 → 逐条执行 → 留痕。返回本次处置摘要。"""
    aid = alert["id"]
    plan, mode = build_plan(alert)

    r = service.accept_alert(aid, AI_USER)
    if not r.get("ok"):
        return {"alert_id": aid, "ok": False, "error": r.get("error")}

    service.add_event(aid, "AI 值守判定：%s，风险 %s，%s" % (
        "大模型" if mode == "llm" else "规则", plan["risk"],
        "可自动闭环" if plan["close"] else "需真人跟进"), AI_NAME)

    actions = []
    for step in plan["steps"]:
        service.add_event(aid, "处置：" + step, AI_NAME)
        actions.append(step)

    notified = []
    if plan["message_to_elder"]:
        service.add_message(alert["elder_id"], AI_USER, plan["message_to_elder"])
        service.add_event(aid, "已给老人留言：" + plan["message_to_elder"], AI_NAME)
        notified.append("elder")
    if plan["message_to_family"]:
        service.add_message(alert["elder_id"], AI_USER, plan["message_to_family"])
        service.add_event(aid, "已通知家属：" + plan["message_to_family"], AI_NAME)
        notified.append("family")

    if plan["on_site"] or alert["level"] == "sos":
        service.escalate_alert(aid, "AI 值守已同步社区值班，需要真人跟进（不能由系统代替上门）")

    closed = False
    if plan["close"]:
        rr = service.close_alert(aid, AI_USER, plan["close_note"] or "AI 值守自动结案")
        closed = bool(rr.get("ok"))

    db.ex("INSERT INTO duty_runs(alert_id,mode,risk,plan,actions,created_at) VALUES(?,?,?,?,?,?)",
          (aid, mode, plan["risk"], json.dumps(plan, ensure_ascii=False),
           json.dumps(actions, ensure_ascii=False), db.now()))

    return {
        "alert_id": aid, "ok": True, "mode": mode, "risk": plan["risk"],
        "actions": actions, "notified": notified, "closed": closed,
        "on_site": plan["on_site"] or alert["level"] == "sos",
    }


def process_pending(limit=MAX_PER_ROUND):
    """接手新工单。只在开关打开时工作。"""
    if not enabled():
        return []
    rows = db.q("SELECT * FROM alerts WHERE status='pending' ORDER BY id LIMIT ?", (limit,))
    out = []
    for a in rows:
        if _seconds_since(a["raised_at"]) < MIN_AGE_SEC:
            continue
        try:
            out.append(handle(a))
        except Exception as ex:
            print("[duty] 处理工单 #%s 失败：%s" % (a["id"], ex))
            out.append({"alert_id": a["id"], "ok": False, "error": str(ex)[:80]})
    return out


def recent(limit=10):
    return db.q("SELECT r.*, a.title, a.level, a.status AS alert_status,"
                " e.display AS elder_name FROM duty_runs r"
                " LEFT JOIN alerts a ON a.id=r.alert_id"
                " LEFT JOIN elders e ON e.id=a.elder_id"
                " ORDER BY r.id DESC LIMIT ?", (limit,))
