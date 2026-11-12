"""业务领域逻辑：用药、体征、告警工单、留言、授权、报表。

所有页面和 AI 动作都走这一层，保证规则只有一份。
"""
from datetime import datetime, timedelta

import db
import notify


# ---------------- 基础 ----------------

def elder(elder_id):
    return db.q1("SELECT * FROM elders WHERE id=?", (elder_id,))


def elder_brief(elder_id):
    e = elder(elder_id) or {}
    return {
        "id": e.get("id"),
        "name": e.get("name"),
        "display": e.get("display") or e.get("name"),
        "age": e.get("age"),
        "address": e.get("address"),
        "device_status": e.get("device_status") or "online",
    }


def ensure_consents(elder_id):
    row = db.q1("SELECT * FROM consents WHERE elder_id=?", (elder_id,))
    if row:
        return row
    db.ex("INSERT INTO consents(elder_id,share_health,radar,location,updated_at) VALUES(?,1,1,0,?)",
          (elder_id, db.now()))
    return db.q1("SELECT * FROM consents WHERE elder_id=?", (elder_id,))


def consents(elder_id):
    return ensure_consents(elder_id)


def set_consents(elder_id, **kw):
    c = ensure_consents(elder_id)
    share = int(kw.get("share_health", c["share_health"]))
    radar = int(kw.get("radar", c["radar"]))
    loc = int(kw.get("location", c["location"]))
    db.ex("UPDATE consents SET share_health=?,radar=?,location=?,updated_at=? WHERE elder_id=?",
          (share, radar, loc, db.now(), elder_id))
    return consents(elder_id)


# ---------------- 用药 ----------------

def _mins(hhmm):
    try:
        h, m = hhmm.split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return 0


def _now_mins():
    n = datetime.now()
    return n.hour * 60 + n.minute


def meds_today(elder_id):
    day = db.today()
    meds = db.q("SELECT * FROM meds WHERE elder_id=? AND active=1 ORDER BY time_hhmm", (elder_id,))
    logs = {r["med_id"]: r for r in db.q(
        "SELECT * FROM med_logs WHERE elder_id=? AND day=?", (elder_id, day))}
    out = []
    nowm = _now_mins()
    for m in meds:
        log = logs.get(m["id"])
        due = _mins(m["time_hhmm"])
        if log and log["status"] == "taken":
            state = "taken"
        elif nowm < due:
            state = "upcoming"
        elif nowm - due <= 90:
            state = "due"
        else:
            state = "late"
        out.append({
            "id": m["id"], "name": m["name"], "dose": m["dose"],
            "time": m["time_hhmm"], "meal": m["meal"], "state": state,
            "taken_at": (log or {}).get("at"),
        })
    return out


def confirm_med(elder_id, med_id=None, source="voice"):
    day = db.today()
    if med_id:
        med = db.q1("SELECT * FROM meds WHERE id=? AND elder_id=?", (med_id, elder_id))
    else:
        # 未指定就取“当前应该吃、还没确认”的那一个
        pending = [m for m in meds_today(elder_id) if m["state"] in ("due", "late")]
        pending.sort(key=lambda m: m["time"])
        med = db.q1("SELECT * FROM meds WHERE id=?", (pending[0]["id"],)) if pending else None
    if not med:
        return {"ok": False, "error": "今天没有待确认的用药"}
    exists = db.q1("SELECT id FROM med_logs WHERE med_id=? AND day=?", (med["id"], day))
    if exists:
        db.ex("UPDATE med_logs SET status='taken', at=?, source=? WHERE id=?",
              (db.now(), source, exists["id"]))
    else:
        db.ex("INSERT INTO med_logs(med_id,elder_id,day,status,at,source) VALUES(?,?,?,'taken',?,?)",
              (med["id"], elder_id, day, db.now(), source))
    return {"ok": True, "med": {"id": med["id"], "name": med["name"], "time": med["time_hhmm"]}}


def list_meds(elder_id, include_inactive=False):
    sql = "SELECT * FROM meds WHERE elder_id=?"
    if not include_inactive:
        sql += " AND active=1"
    sql += " ORDER BY time_hhmm, id"
    return db.q(sql, (elder_id,))


def add_med(elder_id, name, dose, time_hhmm, meal):
    name = (name or "").strip()
    time_hhmm = (time_hhmm or "").strip()
    if not name:
        return {"ok": False, "error": "药名不能为空"}
    if not _valid_time(time_hhmm):
        return {"ok": False, "error": "时间格式应为 HH:MM"}
    dup = db.q1("SELECT id FROM meds WHERE elder_id=? AND name=? AND time_hhmm=? AND active=1",
                (elder_id, name, time_hhmm))
    if dup:
        return {"ok": False, "error": "同一时间已经有这个药了"}
    mid = db.ex("INSERT INTO meds(elder_id,name,dose,time_hhmm,meal,active,created_at)"
                " VALUES(?,?,?,?,?,1,?)",
                (elder_id, name, (dose or "1 片").strip(), time_hhmm, (meal or "").strip(), db.now()))
    return {"ok": True, "id": mid}


def update_med(elder_id, med_id, name=None, dose=None, time_hhmm=None, meal=None):
    m = db.q1("SELECT * FROM meds WHERE id=? AND elder_id=?", (med_id, elder_id))
    if not m:
        return {"ok": False, "error": "用药不存在"}
    if time_hhmm is not None and not _valid_time(time_hhmm):
        return {"ok": False, "error": "时间格式应为 HH:MM"}
    db.ex("UPDATE meds SET name=?, dose=?, time_hhmm=?, meal=? WHERE id=?",
          ((name or m["name"]).strip(), (dose or m["dose"] or "").strip(),
           (time_hhmm or m["time_hhmm"]).strip(), (meal if meal is not None else m["meal"] or "").strip(),
           med_id))
    return {"ok": True}


def deactivate_med(elder_id, med_id):
    m = db.q1("SELECT * FROM meds WHERE id=? AND elder_id=?", (med_id, elder_id))
    if not m:
        return {"ok": False, "error": "用药不存在"}
    db.ex("UPDATE meds SET active=0 WHERE id=?", (med_id,))
    return {"ok": True}


def _valid_time(s):
    try:
        h, m = str(s).split(":")
        return 0 <= int(h) <= 23 and 0 <= int(m) <= 59
    except Exception:
        return False


def family_contact(elder_id):
    c = db.q1("SELECT name,relation,phone FROM users WHERE elder_id=? AND role='family' ORDER BY id LIMIT 1",
              (elder_id,))
    return c or {}


# ---------------- 紧急联系人 ----------------

def ensure_contacts(elder_id):
    """把已有的家属账号补进紧急联系人名单。

    没有这一步，逐级外呼会"没人可打"——账号存在，但联系人表是空的。
    只补手机号合法、还没登记过的，不覆盖用户自己排的顺序。
    家里没有家属账号时，才把老人本人的号码放进来当备用。
    """
    import sms
    have = {r["phone"] for r in db.q("SELECT phone FROM elder_contacts WHERE elder_id=?", (elder_id,))}
    users = db.q("SELECT name,relation,phone,role FROM users WHERE elder_id=? AND role='family'"
                 " ORDER BY id", (elder_id,))
    # 一个能打的都没有时，退一步用老人本人号码兜底，总比没人可加强
    if not have and not [u for u in users if sms.check_phone(u["phone"])[0]]:
        users += db.q("SELECT name,relation,phone,role FROM users WHERE elder_id=? AND role='elder'"
                      " ORDER BY id LIMIT 1", (elder_id,))
    prio = db.q1("SELECT MAX(priority) m FROM elder_contacts WHERE elder_id=?", (elder_id,))
    nxt = int((prio or {}).get("m") or 0) + 1
    for u in users:
        p = sms.normalize(u["phone"])
        if p in have or not sms.check_phone(p)[0]:
            continue
        note = "注册时自动登记" if u["role"] == "family" else "本人号码（备用）"
        db.ex("INSERT INTO elder_contacts(elder_id,name,relation,phone,priority,can_call,note,created_at)"
              " VALUES(?,?,?,?,?,1,?,?)",
              (elder_id, u["name"], u["relation"] or "家属", p, nxt, note, db.now()))
        have.add(p)
        nxt += 1


def contacts(elder_id):
    ensure_contacts(elder_id)
    return db.q("SELECT * FROM elder_contacts WHERE elder_id=? ORDER BY priority, id", (elder_id,))


def add_contact(elder_id, name, relation, phone, priority=None, can_call=1, note=""):
    import sms
    name = (name or "").strip()
    if len(name) < 2:
        return {"ok": False, "error": "请填写联系人姓名"}
    ok, reason, p = sms.check_phone(phone)
    if not ok:
        return {"ok": False, "error": reason}
    if db.q1("SELECT id FROM elder_contacts WHERE elder_id=? AND phone=?", (elder_id, p)):
        return {"ok": False, "error": "这个号码已经在名单里了"}
    try:
        prio = int(priority or 0)
    except Exception:
        prio = 0
    if prio <= 0:
        r = db.q1("SELECT MAX(priority) m FROM elder_contacts WHERE elder_id=?", (elder_id,))
        prio = int((r or {}).get("m") or 0) + 1
    cid = db.ex("INSERT INTO elder_contacts(elder_id,name,relation,phone,priority,can_call,note,created_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (elder_id, name, (relation or "").strip() or "家属", p, prio,
                 1 if can_call else 0, (note or "")[:60], db.now()))
    return {"ok": True, "id": cid}


def update_contact(elder_id, cid, **kw):
    import sms
    row = db.q1("SELECT * FROM elder_contacts WHERE id=? AND elder_id=?", (cid, elder_id))
    if not row:
        return {"ok": False, "error": "联系人不存在"}
    name = (kw.get("name") or row["name"]).strip()
    phone = row["phone"]
    if kw.get("phone"):
        ok, reason, phone = sms.check_phone(kw["phone"])
        if not ok:
            return {"ok": False, "error": reason}
        dup = db.q1("SELECT id FROM elder_contacts WHERE elder_id=? AND phone=? AND id<>?",
                    (elder_id, phone, cid))
        if dup:
            return {"ok": False, "error": "这个号码已经在名单里了"}
    prio = kw.get("priority", row["priority"])
    try:
        prio = max(1, int(prio))
    except Exception:
        prio = row["priority"]
    can_call = row["can_call"] if kw.get("can_call") is None else (1 if kw["can_call"] else 0)
    db.ex("UPDATE elder_contacts SET name=?,relation=?,phone=?,priority=?,can_call=?,note=?"
          " WHERE id=?",
          (name, (kw.get("relation") or row["relation"] or "").strip() or "家属", phone, prio,
           can_call, (kw.get("note") or row["note"] or "")[:60], cid))
    return {"ok": True}


def delete_contact(elder_id, cid):
    row = db.q1("SELECT id FROM elder_contacts WHERE id=? AND elder_id=?", (cid, elder_id))
    if not row:
        return {"ok": False, "error": "联系人不存在"}
    db.ex("DELETE FROM elder_contacts WHERE id=?", (cid,))
    return {"ok": True}


def callable_contacts(elder_id):
    return db.q("SELECT * FROM elder_contacts WHERE elder_id=? AND can_call=1"
                " ORDER BY priority, id", (elder_id,))


def log_call(alert_id, elder_id, contact, stage, ok, status, message=""):
    db.ex("INSERT INTO call_logs(alert_id,elder_id,phone,name,stage,ok,status,message,created_at)"
          " VALUES(?,?,?,?,?,?,?,?,?)",
          (alert_id, elder_id, contact.get("phone"), contact.get("name"), stage,
           1 if ok else 0, str(status)[:20], (message or "")[:200], db.now()))


def call_logs(alert_id):
    return db.q("SELECT * FROM call_logs WHERE alert_id=? ORDER BY id DESC LIMIT 30", (alert_id,))


# ---------------- 家属绑定码 ----------------

BIND_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def new_bind_code(elder_id, role="any", hours=72):
    import secrets
    if not elder(elder_id):
        return {"ok": False, "error": "老人档案不存在"}
    # 同一个老人只保留一个未使用的码，避免满屏都是码
    db.ex("UPDATE bind_codes SET used_at=? WHERE elder_id=? AND used_at IS NULL",
          (db.now(), elder_id))
    code = "".join(secrets.choice(BIND_ALPHABET) for _ in range(6))
    exp = (datetime.now() + timedelta(hours=int(hours or 72))).strftime("%Y-%m-%d %H:%M:%S")
    db.ex("INSERT INTO bind_codes(elder_id,code,role,expires_at,created_at) VALUES(?,?,?,?,?)",
          (elder_id, code, role if role in ("family", "elder") else "any", exp, db.now()))
    return {"ok": True, "code": code, "expires_at": exp, "hours": int(hours or 72)}


def active_bind_code(elder_id):
    r = db.q1("SELECT * FROM bind_codes WHERE elder_id=? AND used_at IS NULL AND expires_at>?"
              " ORDER BY id DESC LIMIT 1", (elder_id, db.now()))
    return r



def med_progress(elder_id):
    items = meds_today(elder_id)
    taken = len([m for m in items if m["state"] == "taken"])
    return {"taken": taken, "total": len(items), "items": items}


# ---------------- 体征 ----------------

def add_vital(elder_id, sys_, dia, pulse=None, source="manual"):
    sys_ = int(sys_); dia = int(dia)
    if not (60 <= sys_ <= 260 and 30 <= dia <= 200):
        return {"ok": False, "error": "血压数值超出合理范围"}
    pid = db.ex(
        "INSERT INTO vitals(elder_id,sys,dia,pulse,measured_at,source) VALUES(?,?,?,?,?,?)",
        (elder_id, sys_, dia, int(pulse) if pulse else None, db.now(), source))
    return {"ok": True, "id": pid, "sys": sys_, "dia": dia, "pulse": pulse}


def latest_vital(elder_id):
    return db.q1("SELECT * FROM vitals WHERE elder_id=? ORDER BY measured_at DESC, id DESC LIMIT 1",
                 (elder_id,))


def vital_series(elder_id, days=7):
    since = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d 00:00:00")
    return db.q("SELECT sys,dia,pulse,measured_at FROM vitals WHERE elder_id=? AND measured_at>=?"
                " ORDER BY measured_at", (elder_id, since))


# ---------------- 告警与工单 ----------------

def create_alert(elder_id, level, title, detail="", source="system", status="pending"):
    aid = db.ex(
        "INSERT INTO alerts(elder_id,level,title,detail,source,status,raised_at)"
        " VALUES(?,?,?,?,?,?,?)",
        (elder_id, level, title, detail, source, status, db.now()))
    add_event(aid, "事件触发：" + title, "系统")
    if level == "sos":
        # 紧急求助：立刻推送到所有已配置通道（企业微信/短信/电话…），不阻塞响应
        notify.send_async({"id": aid, "level": level, "title": title,
                           "detail": detail, "raised_at": db.now()},
                          elder(elder_id) or {}, aid)
        # 同时给每个紧急联系人发短信：群消息可能没人看，短信会响
        notify.sms_alert_async(aid, elder_id, title, detail)
    return aid


# ---------------- 逐级外呼 ----------------

# (多少秒之后, 打到第几级, 说明)
ESCALATION_LADDER = [
    (60, 1, "60 秒无人接单，开始电话联系第 1 顺位家属"),
    (180, 2, "3 分钟仍无人接单，加呼第 2 顺位家属"),
    (300, 3, "5 分钟仍无人接单，加呼第 3 顺位与社区值班"),
    (600, 4, "10 分钟仍未处理，转为全员循环外呼"),
]
CALL_REPEAT_SEC = 300   # 第 4 级之后每 5 分钟重呼一轮


def _age_seconds(ts):
    try:
        return (datetime.now() - datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")).total_seconds()
    except Exception:
        return 0


def escalation_plan(alert_id):
    """算出这条工单"现在该打到第几级、打给谁"。纯函数，方便单独验证。"""
    a = get_alert(alert_id)
    if not a or a["level"] != "sos" or a["status"] in ("closed",):
        return None
    age = _age_seconds(a["raised_at"])
    stage_now = int(a.get("call_stage") or 0)
    target = 0
    for sec, lvl, _ in ESCALATION_LADDER:
        if age >= sec:
            target = lvl
    if target <= stage_now:
        # 到了第 4 级就循环重呼，按 CALL_REPEAT_SEC 节流
        if stage_now >= 4 and age >= 600:
            last = a.get("last_call_at")
            if not last or _age_seconds(last) >= CALL_REPEAT_SEC:
                return {"alert": a, "stage": 4, "repeat": True,
                        "contacts": _contacts_for_stage(a, 4)}
        return None
    return {"alert": a, "stage": target, "repeat": False,
            "contacts": _contacts_for_stage(a, target)}


def _contacts_for_stage(a, stage):
    rows = callable_contacts(a["elder_id"])
    if stage == 1:
        rows = rows[:1]
    elif stage == 2:
        rows = rows[:2]
    elif stage == 3:
        rows = rows[:3]
    out = [dict(r) for r in rows]
    if stage >= 3:
        duty_phone = (db.setting_get("voice_called") or "").strip()
        if duty_phone and not any(r["phone"] == duty_phone for r in out):
            out.append({"id": None, "name": "社区值班", "relation": "值班电话",
                        "phone": duty_phone, "priority": 99})
    return out


def run_escalation(alert_id):
    """推进一级。打电话放到后台线程，别把扫描循环卡住。"""
    plan = escalation_plan(alert_id)
    if not plan:
        return None
    a, stage = plan["alert"], plan["stage"]
    people = plan["contacts"]
    if not people:
        note = "触发外呼升级，但这位老人还没有可拨打的紧急联系人，请尽快补录"
        if not db.q1("SELECT id FROM alert_events WHERE alert_id=? AND text LIKE ?",
                     (alert_id, "%没有可拨打的紧急联系人%")):
            add_event(alert_id, note, "系统")
        db.ex("UPDATE alerts SET call_stage=?, last_call_at=? WHERE id=?",
              (max(stage, int(a.get("call_stage") or 0)), db.now(), alert_id))
        return {"alert_id": alert_id, "stage": stage, "called": 0, "note": note}

    label = dict((lvl, txt) for _, lvl, txt in ESCALATION_LADDER).get(stage, "外呼")
    who = "、".join("%s(%s)" % (p.get("name"), (p.get("phone") or "")[-4:]) for p in people)
    add_event(alert_id, "%s：拨打 %s" % (label if not plan.get("repeat") else "循环外呼", who), "系统")
    db.ex("UPDATE alerts SET call_stage=?, escalated=1, last_call_at=? WHERE id=?",
          (max(stage, int(a.get("call_stage") or 0)), db.now(), alert_id))

    elder_row = elder(a["elder_id"]) or {}
    reason = (a.get("title") or "紧急求助").replace("紧急求助：", "")[:20]
    for p in people:
        notify.call_async(alert_id, a["elder_id"], dict(p), stage,
                          elder_row.get("display") or elder_row.get("name") or "老人", reason)
    # 第 1 级同时补一条短信，电话没人接时至少手机上有字
    if stage == 1:
        notify.sms_alert_async(alert_id, a["elder_id"], a.get("title") or "", a.get("detail") or "")
    return {"alert_id": alert_id, "stage": stage, "called": len(people), "people": who}



# 老人自述里一旦出现这些词，直接按紧急处理，不再等家属判断
HIGH_RISK_WORDS = (
    "胸痛", "胸口", "心口", "喘不上气", "喘不过气", "呼吸困难", "憋气",
    "晕倒", "昏倒", "昏迷", "意识不清", "说不出话", "嘴歪", "半边",
    "吐血", "大出血", "流血不止", "摔", "跌倒", "起不来", "骨折",
)


def add_symptom(elder_id, text, severity=None, source="voice"):
    """老人说自己不舒服：落一条症状记录，并真的生成告警通知家属/社区。"""
    text = (text or "").strip()[:120]
    if not text:
        return {"ok": False, "kind": "report_symptom", "error": "没有听清哪里不舒服"}
    if severity not in ("normal", "high"):
        severity = "high" if any(w in text for w in HIGH_RISK_WORDS) else "normal"
    level = "sos" if severity == "high" else "warn"

    at = db.now()
    sid = db.ex(
        "INSERT INTO symptoms(elder_id,text,severity,at,source) VALUES(?,?,?,?,?)",
        (elder_id, text, severity, at, source))

    if level == "sos":
        title = "紧急：老人说「%s」" % text
        detail = "老人自述：%s。可能属于急症，已按紧急求助升级，请立即联系确认。" % text
    else:
        title = "老人说不舒服：%s" % text
        detail = "老人自述：%s。已记录，请家属或社区医生回电问一下情况。" % text
    aid = create_alert(elder_id, level, title, detail, source="symptom")
    db.ex("UPDATE symptoms SET alert_id=? WHERE id=?", (aid, sid))
    return {"ok": True, "kind": "report_symptom", "symptom_id": sid,
            "alert_id": aid, "level": level, "severity": severity}


def heartbeat(elder_id, path="", ip=""):
    """老人端保活：只有页面开着才会发，用来判断"设备还活着"。"""
    db.ex("INSERT INTO heartbeats(elder_id,last_seen,last_path,ip) VALUES(?,?,?,?)"
          " ON CONFLICT(elder_id) DO UPDATE SET last_seen=excluded.last_seen,"
          " last_path=excluded.last_path, ip=excluded.ip",
          (elder_id, db.now(), (path or "")[:60], (ip or "")[:40]))
    db.ex("UPDATE elders SET last_seen=?, device_status='online' WHERE id=?", (db.now(), elder_id))
    return {"ok": True, "at": db.now()}


def heartbeat_status(elder_id):
    row = db.q1("SELECT * FROM heartbeats WHERE elder_id=?", (elder_id,))
    e = db.q1("SELECT watch FROM elders WHERE id=?", (elder_id,)) or {}
    if not row:
        return {"watch": bool(e.get("watch")), "last_seen": None, "minutes": None, "alive": None}
    try:
        mins = round((datetime.now() - datetime.strptime(
            row["last_seen"], "%Y-%m-%d %H:%M:%S")).total_seconds() / 60.0, 1)
    except Exception:
        mins = None
    return {"watch": bool(e.get("watch")), "last_seen": row["last_seen"],
            "minutes": mins, "alive": (mins is not None and mins < 10)}


def set_watch(elder_id, on):
    db.ex("UPDATE elders SET watch=? WHERE id=?", (1 if on else 0, elder_id))
    return {"ok": True, "watch": bool(on)}


def list_symptoms(elder_id, limit=20):
    return db.q("SELECT * FROM symptoms WHERE elder_id=? ORDER BY id DESC LIMIT ?",
                (elder_id, limit))


def last_activity(elder_id):
    """老人最后一次留下痕迹的时间，用于“长时间没动静”判断。"""
    row = db.q1(
        "SELECT MAX(t) AS t FROM ("
        "  SELECT MAX(created_at) AS t FROM chats WHERE elder_id=?"
        "  UNION ALL SELECT MAX(measured_at) FROM vitals WHERE elder_id=?"
        "  UNION ALL SELECT MAX(at) FROM med_logs WHERE elder_id=?"
        "  UNION ALL SELECT MAX(at) FROM symptoms WHERE elder_id=?"
        "  UNION ALL SELECT MAX(raised_at) FROM alerts WHERE elder_id=?"
        ")", (elder_id, elder_id, elder_id, elder_id, elder_id))
    return (row or {}).get("t")


def add_event(alert_id, text, actor="系统"):
    return db.ex("INSERT INTO alert_events(alert_id,at,actor,text) VALUES(?,?,?,?)",
                 (alert_id, db.now(), actor, text))


def alert_events(alert_id):
    return db.q("SELECT * FROM alert_events WHERE alert_id=? ORDER BY id", (alert_id,))


OPEN_STATUS = ("pending", "accepted", "arrived")


def list_alerts(elder_id=None, status=None, limit=80):
    sql = ("SELECT a.*, e.name AS elder_name, e.address AS elder_address FROM alerts a"
           " LEFT JOIN elders e ON e.id=a.elder_id")
    args = []
    where = []
    if elder_id:
        where.append("a.elder_id=?")
        args.append(elder_id)
    if status == "open":
        where.append("a.status IN ('pending','accepted','arrived')")
    elif status:
        where.append("a.status=?")
        args.append(status)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY a.raised_at DESC, a.id DESC LIMIT ?"
    args.append(limit)
    return db.q(sql, tuple(args))


def get_alert(alert_id):
    return db.q1("SELECT * FROM alerts WHERE id=?", (alert_id,))


def accept_alert(alert_id, user):
    a = get_alert(alert_id)
    if not a:
        return {"ok": False, "error": "工单不存在"}
    if a["status"] != "pending":
        return {"ok": False, "error": "工单已被接单"}
    db.ex("UPDATE alerts SET status='accepted', accepted_at=?, assignee_id=?, assignee_name=?"
          " WHERE id=?", (db.now(), user["id"], user["name"], alert_id))
    add_event(alert_id, "%s 接单" % user["name"], user["name"])
    return {"ok": True}


def arrive_alert(alert_id, user):
    a = get_alert(alert_id)
    if not a:
        return {"ok": False, "error": "工单不存在"}
    if a["status"] not in ("accepted", "pending"):
        return {"ok": False, "error": "当前状态不可标记到场"}
    db.ex("UPDATE alerts SET status='arrived', arrived_at=?,"
          " accepted_at=COALESCE(accepted_at,?), assignee_id=COALESCE(assignee_id,?),"
          " assignee_name=COALESCE(assignee_name,?) WHERE id=?",
          (db.now(), db.now(), user["id"], user["name"], alert_id))
    add_event(alert_id, "%s 标记已到场" % user["name"], user["name"])
    return {"ok": True}


def close_alert(alert_id, user, note="已确认安全"):
    a = get_alert(alert_id)
    if not a:
        return {"ok": False, "error": "工单不存在"}
    if a["status"] == "closed":
        return {"ok": False, "error": "工单已结案"}
    db.ex("UPDATE alerts SET status='closed', closed_at=? WHERE id=?", (db.now(), alert_id))
    add_event(alert_id, "%s 结案：%s" % (user["name"], note), user["name"])
    return {"ok": True}


def reopen_alert(alert_id, user, note="重新打开"):
    """AI 自动结的案如果不对，人工可以重新打开——自动化的安全阀。"""
    a = get_alert(alert_id)
    if not a:
        return {"ok": False, "error": "工单不存在"}
    if a["status"] != "closed":
        return {"ok": False, "error": "工单还没结案"}
    db.ex("UPDATE alerts SET status='accepted', closed_at=NULL,"
          " accepted_at=COALESCE(accepted_at,?), assignee_name=COALESCE(assignee_name,?)"
          " WHERE id=?", (db.now(), user["name"], alert_id))
    add_event(alert_id, "%s 重新打开工单：%s" % (user["name"], note), user["name"])
    return {"ok": True}


def escalate_alert(alert_id, note):
    db.ex("UPDATE alerts SET escalated=1 WHERE id=?", (alert_id,))
    add_event(alert_id, note, "系统")
    a = get_alert(alert_id)
    if a and a["level"] == "sos":
        notify.send_async({"id": alert_id, "level": "sos",
                           "title": "仍未处理：" + (a["title"] or ""),
                           "detail": note, "raised_at": db.now()},
                          elder(a["elder_id"]) or {}, alert_id)


# ---------------- 留言 ----------------

def list_messages(elder_id, limit=30):
    return db.q("SELECT * FROM messages WHERE elder_id=? ORDER BY created_at DESC, id DESC LIMIT ?",
                (elder_id, limit))


def add_message(elder_id, user, text):
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "留言不能为空"}
    if len(text) > 500:
        return {"ok": False, "error": "留言过长"}
    mid = db.ex("INSERT INTO messages(elder_id,from_user,from_name,text,created_at) VALUES(?,?,?,?,?)",
                (elder_id, user["id"], user["name"], text, db.now()))
    return {"ok": True, "id": mid}


def mark_messages_read(elder_id):
    db.ex("UPDATE messages SET read_at=? WHERE elder_id=? AND read_at IS NULL", (db.now(), elder_id))


def unread_count(elder_id):
    r = db.q1("SELECT COUNT(*) AS n FROM messages WHERE elder_id=? AND read_at IS NULL", (elder_id,))
    return r["n"] if r else 0


# ---------------- 报表与指标 ----------------

def report(elder_id, days=7):
    since_day = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    meds = db.q("SELECT id FROM meds WHERE elder_id=? AND active=1", (elder_id,))
    expected = len(meds) * days
    taken_rows = db.q("SELECT COUNT(*) AS n FROM med_logs WHERE elder_id=? AND day>=? AND status='taken'",
                      (elder_id, since_day))
    taken = taken_rows[0]["n"] if taken_rows else 0
    vit = vital_series(elder_id, days)
    msg = db.q1("SELECT COUNT(*) AS n FROM messages WHERE elder_id=? AND created_at>=?",
                (elder_id, since_day + " 00:00:00"))
    al = db.q("SELECT level,status,raised_at FROM alerts WHERE elder_id=? AND raised_at>=?",
              (elder_id, since_day + " 00:00:00"))
    return {
        "days": days,
        "adherence": round(taken / expected * 100) if expected else None,
        "expected": expected,
        "taken": taken,
        "vitals": vit,
        "vital_count": len(vit),
        "messages": msg["n"] if msg else 0,
        "alerts": len(al),
        "sos": len([a for a in al if a["level"] == "sos"]),
        "closed": len([a for a in al if a["status"] == "closed"]),
    }


def metrics():
    since = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d 00:00:00")
    rows = db.q("SELECT * FROM alerts WHERE raised_at>=?", (since,))
    by_src = {}
    for a in rows:
        k = a["source"] or "other"
        by_src[k] = by_src.get(k, 0) + 1
    resp = []
    for a in rows:
        if a["accepted_at"]:
            try:
                t0 = datetime.strptime(a["raised_at"], "%Y-%m-%d %H:%M:%S")
                t1 = datetime.strptime(a["accepted_at"], "%Y-%m-%d %H:%M:%S")
                resp.append((t1 - t0).total_seconds())
            except Exception:
                pass
    # 积压太久的单（>1 小时）会严重拉偏均值，用中位数并剔除异常值
    resp = sorted(x for x in resp if 0 <= x <= 3600)
    median = None
    if resp:
        mid = len(resp) // 2
        median = resp[mid] if len(resp) % 2 else round((resp[mid - 1] + resp[mid]) / 2.0, 1)
    elders = db.q("SELECT device_status FROM elders")
    online = len([e for e in elders if (e["device_status"] or "online") == "online"])
    return {
        "alerts_7d": len(rows),
        "by_source": by_src,
        "avg_response_sec": median,
        "responded": len(resp),
        "ai_handled": db.q1("SELECT COUNT(*) n FROM duty_runs WHERE created_at>=?",
                            (since,))["n"],
        "elders": len(elders),
        "online": online,
        "online_rate": round(online / len(elders) * 100, 1) if elders else None,
    }


def roster():
    out = []
    for e in db.q("SELECT * FROM elders ORDER BY id"):
        prog = med_progress(e["id"])
        alerts = db.q1("SELECT COUNT(*) AS n FROM alerts WHERE elder_id=? AND status IN"
                       " ('pending','accepted','arrived')", (e["id"],))
        last = db.q1("SELECT title,raised_at FROM alerts WHERE elder_id=? ORDER BY id DESC LIMIT 1",
                     (e["id"],))
        out.append({
            "id": e["id"], "name": e["name"], "age": e["age"], "address": e["address"],
            "conditions": e["conditions"], "device_status": e["device_status"] or "online",
            "meds": "%d / %d" % (prog["taken"], prog["total"]),
            "open_alerts": alerts["n"] if alerts else 0,
            "last_event": (last or {}).get("title"),
            "last_at": (last or {}).get("raised_at"),
        })
    return out


def elder_overview(elder_id):
    e = elder(elder_id) or {}
    prog = med_progress(elder_id)
    return {
        "elder": elder_brief(elder_id),
        "meds": prog["items"],
        "med_progress": {"taken": prog["taken"], "total": prog["total"]},
        "vital": latest_vital(elder_id),
        "vitals": vital_series(elder_id, 7),
        "contact": family_contact(elder_id),
        "unread": unread_count(elder_id),
        "open_alerts": len(list_alerts(elder_id, status="open")),
        "profile": {k: e.get(k) for k in
                    ("blood_type", "conditions", "allergies", "community", "address")},
    }
