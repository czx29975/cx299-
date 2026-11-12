"""后台任务：用药超时提醒、SOS 超时升级、会话清理。

每 15 秒扫描一次，所有动作都写库留痕，和人工操作走同一套告警表。
"""
import threading
import time
from datetime import datetime

import db
import duty
import service

_stop = threading.Event()
_thread = None
TICK = 15
SOS_ESCALATE_1 = 60    # 秒：未接单 -> 通知社区值班
SOS_ESCALATE_2 = 180   # 秒：未到场 -> 建议转 120
MED_LATE_MIN = 90      # 分钟：过点 90 分钟仍未确认 -> 通知家属
INACTIVE_HOURS = 6     # 小时：连续多久没有任何交互算“没动静”
INACTIVE_FROM = 10     # 上午 10 点后才检查，避免清晨误报
INACTIVE_TO = 21       # 晚上 9 点后不再新建
HEARTBEAT_GAP_MIN = 10 # 分钟：设备多久没心跳算失联
HB_FROM, HB_TO = 7, 23 # 只在 7:00–23:00 检查设备


def _seconds_since(ts):
    try:
        t0 = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
        return (datetime.now() - t0).total_seconds()
    except Exception:
        return 0


def _has_alert_today(elder_id, source, title_like):
    today = db.today()
    r = db.q1(
        "SELECT id FROM alerts WHERE elder_id=? AND source=? AND title LIKE ?"
        " AND raised_at>=? LIMIT 1",
        (elder_id, source, "%" + title_like + "%", today + " 00:00:00"),
    )
    return bool(r)


def scan_meds():
    for e in db.q("SELECT id FROM elders"):
        try:
            items = service.meds_today(e["id"])
        except Exception as ex:
            print("[jobs] 用药扫描失败 elder=%s：%s" % (e["id"], ex))
            continue
        for m in items:
            if m["state"] != "late":
                continue
            title = "用药未确认：%s" % m["name"]
            if _has_alert_today(e["id"], "med", "用药未确认：" + m["name"]):
                continue
            aid = service.create_alert(
                e["id"], "warn", title,
                "%s 的%s（%s）到点后一直没确认，请家属回电提醒。" % (m["time"], m["name"], m["meal"] or ""),
                source="med",
            )
            service.add_event(aid, "系统自动建单：超过 %d 分钟未确认用药" % MED_LATE_MIN, "系统")


def scan_sos():
    rows = db.q("SELECT * FROM alerts WHERE level='sos' AND status IN ('pending','accepted','arrived')")
    for a in rows:
        age = _seconds_since(a["raised_at"])
        if age >= SOS_ESCALATE_1 and not a["escalated"] and a["status"] == "pending":
            service.escalate_alert(a["id"], "已超过 %d 秒无人接单，自动通知社区值班与家属" % SOS_ESCALATE_1)
        if age >= SOS_ESCALATE_2:
            has2 = db.q1("SELECT id FROM alert_events WHERE alert_id=? AND text LIKE '%转 120%'", (a["id"],))
            if not has2:
                service.add_event(a["id"], "已超过 3 分钟未到场，系统建议立即转 120", "系统")


def scan_escalation():
    """逐级外呼：没人接单就一直往上叫人，直到有人点"接单"为止。

    只在 pending 状态推进——一旦有人接单，说明人已经在路上，再打就是骚扰。
    """
    for a in db.q("SELECT id FROM alerts WHERE level='sos' AND status='pending'"):
        try:
            r = service.run_escalation(a["id"])
            if r:
                print("[escalation] 工单 #%s 第 %s 级：拨打 %s 人（%s）" %
                      (r["alert_id"], r["stage"], r["called"], r.get("people") or r.get("note") or ""),
                      flush=True)
        except Exception as ex:
            print("[escalation] 工单 #%s 升级失败：%s" % (a["id"], ex), flush=True)


def scan_inactivity():
    """长时间没有任何动静（不说话、不确认药、不量血压）就提醒家属回电。

    独居老人最危险的不是喊救命，而是喊不出来。这条只在白天生效，每人每天最多一次。
    """
    now = datetime.now()
    if not (INACTIVE_FROM <= now.hour < INACTIVE_TO):
        return
    for e in db.q("SELECT id, display, name FROM elders"):
        eid = e["id"]
        try:
            last = service.last_activity(eid)
            if not last:
                continue
            hours = _seconds_since(last) / 3600.0
            if hours < INACTIVE_HOURS:
                continue
            if _has_alert_today(eid, "inactive", "长时间没有动静"):
                continue
            who = e.get("display") or e.get("name") or "老人"
            aid = service.create_alert(
                eid, "warn",
                "长时间没有动静：%.0f 小时未交互" % hours,
                "%s 最后一次留下记录是 %s。今天没有确认用药、没有量血压、也没有说话，"
                "建议回个电话问一声。" % (who, last[:16]),
                source="inactive",
            )
            service.add_event(aid, "系统自动建单：超过 %d 小时无任何交互" % INACTIVE_HOURS, "系统")
        except Exception as ex:
            print("[jobs] 静默检测失败 elder=%s：%s" % (eid, ex))


_last_duty = 0.0
DUTY_EVERY = 5  # 秒：AI 值守的处理间隔


def scan_duty():
    """AI 值守：把待接单的工单交给 AI 处理（开关在社区端）。"""
    global _last_duty
    now = time.time()
    if now - _last_duty < DUTY_EVERY:
        return
    _last_duty = now
    try:
        done = duty.process_pending()
        for r in done:
            if r.get("ok"):
                print("[duty] 工单 #%s 已处置（%s/%s，%s）" % (
                    r["alert_id"], r["mode"], r["risk"], "已结案" if r["closed"] else "待跟进"))
    except Exception as ex:
        print("[duty] 值守异常：%s" % ex)


def scan_heartbeat():
    """设备失联：老人端在开着却没心跳，说明设备/网络可能出问题，这时连求救都发不出来。"""
    now = datetime.now()
    if not (HB_FROM <= now.hour < HB_TO):
        return
    for e in db.q("SELECT id, display, name FROM elders WHERE watch=1"):
        hb = db.q1("SELECT last_seen FROM heartbeats WHERE elder_id=?", (e["id"],))
        if not hb:
            continue  # 从没连过，没有基线，不误报
        mins = _seconds_since(hb["last_seen"]) / 60.0
        if mins < HEARTBEAT_GAP_MIN:
            continue
        if _has_alert_today(e["id"], "device", "设备失联"):
            continue
        who = e.get("display") or e.get("name") or "老人"
        aid = service.create_alert(
            e["id"], "warn", "设备失联：%.0f 分钟无心跳" % mins,
            "%s 的终端已经 %.0f 分钟没有响应，可能是断网、断电或设备被关。"
            "这段时间里老人无法通过语音或按钮求助，建议电话确认。" % (who, mins),
            source="device")
        service.add_event(aid, "系统自动建单：终端超过 %d 分钟未上报心跳" % HEARTBEAT_GAP_MIN, "系统")


def cleanup_sessions():
    db.ex("DELETE FROM sessions WHERE expires_at < ?", (db.now(),))


def _loop():
    print("[jobs] 后台任务已启动（每 %d 秒扫描一次）" % TICK)
    while not _stop.is_set():
        try:
            cleanup_sessions()
            scan_meds()
            scan_sos()
            scan_escalation()
            scan_inactivity()
            scan_heartbeat()
            scan_duty()
        except Exception as ex:
            print("[jobs] 扫描异常：%s" % ex)
        _stop.wait(TICK)


def start():
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="anyu-jobs", daemon=True)
    _thread.start()


def stop():
    _stop.set()
