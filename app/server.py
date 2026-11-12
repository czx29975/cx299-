"""安语 · 居家养老语音助手 —— 服务端入口。

零第三方依赖：Python 标准库 HTTP 服务 + SQLite。
  python server.py            启动 HTTP(8080) 与 HTTPS(8443，若证书存在)
"""
import json
import mimetypes
import os
import socket
import ssl
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import ai
import auth
import config
import db
import notify
import sms
import duty
import jobs
import service

mimetypes.add_type("application/manifest+json", ".webmanifest")

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")

PUBLIC_PAGES = {"/login.html", "/register.html", "/setup.html", "/assets/app.css",
                "/assets/api.js", "/assets/login.js", "/assets/register.js",
                "/assets/setup.js", "/favicon.svg"}
ROLE_PAGES = {
    "/elder.html": ("elder",),
    "/family.html": ("family",),
    "/console.html": ("community", "admin"),
}

# 登录失败节流（进程内即可，重启清零）
_FAILS = {}
_FAIL_LOCK = threading.Lock()
FAIL_MAX = 8
FAIL_WINDOW = 600


def log(*a):
    print(*a, flush=True)


def mask_phone(p):
    p = str(p or "")
    return p[:3] + "****" + p[-4:] if len(p) == 11 else p


class ApiError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "Anyu/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- 基础工具 ----------

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            return  # 接口日志交给业务打印，避免刷屏
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, obj, code=200, extra=None):
        self._send(code, json.dumps(obj, ensure_ascii=False), extra=extra)

    def read_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 1024 * 512:
                return {}
            raw = self.rfile.read(n)
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    def user(self):
        cookie = auth.parse_cookies(self.headers.get("Cookie"))
        return auth.user_from_token(cookie.get(auth.SESSION_COOKIE))

    def need(self, roles=None):
        u = self.user()
        if not u:
            raise ApiError(401, "请先登录")
        if roles and u["role"] not in roles:
            raise ApiError(403, "没有权限")
        return u

    def need_elder(self, u):
        eid = u.get("elder_id")
        if not eid:
            eid = db.q1("SELECT id FROM elders ORDER BY id LIMIT 1")
            eid = eid["id"] if eid else None
        if not eid:
            raise ApiError(400, "还没有老人档案，请先完成初始化")
        return eid

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For") or ""
        if fwd:
            return fwd.split(",")[0].strip()[:40]
        return (self.client_address[0] if self.client_address else "")[:40]

    # 密码爆破防护：同一 IP + 同一手机号 10 分钟内错 8 次就锁一会儿
    def _fail_key(self, phone):
        return "%s|%s" % (self.client_ip(), (phone or "").strip())

    def too_many_fails(self, phone):
        k = self._fail_key(phone)
        with _FAIL_LOCK:
            n, ts = _FAILS.get(k, (0, 0))
            if time.time() - ts > FAIL_WINDOW:
                _FAILS.pop(k, None)
                return False
            return n >= FAIL_MAX

    def note_fail(self, phone):
        k = self._fail_key(phone)
        with _FAIL_LOCK:
            n, ts = _FAILS.get(k, (0, 0))
            if time.time() - ts > FAIL_WINDOW:
                n = 0
            _FAILS[k] = (n + 1, time.time())

    def clear_fails(self, phone):
        with _FAIL_LOCK:
            _FAILS.pop(self._fail_key(phone), None)

    # ---------- 路由 ----------

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)
            if path.startswith("/api/"):
                return self.api_get(path, qs)
            return self.serve_static(path)
        except ApiError as e:
            self.json({"ok": False, "error": e.message}, e.code)
        except BrokenPipeError:
            pass
        except Exception:
            traceback.print_exc()
            self.json({"ok": False, "error": "服务器内部错误"}, 500)

    do_HEAD = do_GET

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            body = self.read_json()
            if path.startswith("/api/"):
                return self.api_post(path, body)
            self.json({"ok": False, "error": "不支持的请求"}, 404)
        except ApiError as e:
            self.json({"ok": False, "error": e.message}, e.code)
        except BrokenPipeError:
            pass
        except Exception:
            traceback.print_exc()
            self.json({"ok": False, "error": "服务器内部错误"}, 500)

    def do_PATCH(self):
        self.do_POST()

    # ---------- 静态页面 ----------

    def serve_static(self, path):
        if path in ("/", "/index.html"):
            u = self.user()
            if not u:
                return self.redirect("/login.html")
            target = {"elder": "/elder.html", "family": "/family.html",
                      "community": "/console.html", "admin": "/console.html"}.get(u["role"], "/login.html")
            return self.redirect(target)

        if path in ROLE_PAGES:
            u = self.user()
            if not u:
                return self.redirect("/login.html?next=" + path)
            if u["role"] not in ROLE_PAGES[path]:
                home = {"elder": "/elder.html", "family": "/family.html",
                        "community": "/console.html", "admin": "/console.html"}.get(u["role"], "/login.html")
                return self.redirect(home)
        elif path in ("/login.html", "/setup.html", "/register.html"):
            if path == "/setup.html" and db.has_users():
                return self.redirect("/login.html")
            if path in ("/login.html", "/register.html") and not db.has_users():
                # 还没初始化就先走向导，否则会没有社区账号、也没人管工单
                return self.redirect("/setup.html")

        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB, rel))
        if not full.startswith(WEB) or not os.path.isfile(full):
            return self._send(404, "页面不存在", "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            data = f.read()
        extra = [("Cache-Control", "no-store")] if full.endswith(".html") else \
                [("Cache-Control", "no-cache")] if full.endswith((".js", ".css")) else \
                [("Cache-Control", "public, max-age=300")]
        self._send(200, data, ctype, extra)

    def redirect(self, location):
        self._send(302, b"", "text/plain; charset=utf-8", [("Location", location)])

    # ---------- 读接口 ----------

    def api_get(self, path, qs):
        if path == "/api/health":
            return self.json({"ok": True, "llm": ai.status()["configured"],
                              "sms": sms.status()["mode"]})

        if path == "/api/setup/status":
            return self.json({"ok": True, "needs_setup": not db.has_users()})

        if path == "/api/captcha":
            return self.json({"ok": True, **sms.issue_captcha()})

        if path == "/api/sms/status":
            st = sms.status()
            return self.json({"ok": True, "provider_label": st["provider_label"],
                              "ready": st["ready"], "mode": st["mode"]})

        if path == "/api/me":
            u = self.need()
            return self.json({"ok": True, "user": u})

        if path == "/api/llm/status":
            self.need(("community", "admin"))
            return self.json({"ok": True, **ai.status()})

        if path == "/api/elder/overview":
            u = self.need(("elder",))
            eid = self.need_elder(u)
            data = service.elder_overview(eid)
            data["messages"] = service.list_messages(eid, 5)
            data["last_activity"] = service.last_activity(eid)
            data["symptoms"] = service.list_symptoms(eid, 3)
            data["heartbeat"] = service.heartbeat_status(eid)
            return self.json({"ok": True, **data})

        if path == "/api/messages":
            u = self.need(("elder", "family"))
            eid = self.need_elder(u)
            return self.json({"ok": True, "items": service.list_messages(eid, 40)})

        if path == "/api/meds":
            u = self.need(("elder", "family", "community", "admin"))
            eid = self.need_elder(u)
            include_off = (qs.get("all") or [""])[0] == "1"
            plan = service.list_meds(eid, include_inactive=include_off)
            today = {m["id"]: m for m in service.meds_today(eid)}
            for m in plan:
                m["today"] = (today.get(m["id"]) or {}).get("state")
                m["taken_at"] = (today.get(m["id"]) or {}).get("taken_at")
            return self.json({"ok": True, "items": plan})

        if path == "/api/symptoms":
            u = self.need(("elder", "family", "community", "admin"))
            eid = self.need_elder(u) if u["role"] != "admin" else None
            limit = int((qs.get("limit") or ["20"])[0])
            if u["role"] == "community":
                rows = db.q("SELECT s.*, e.display AS elder_name FROM symptoms s"
                            " JOIN elders e ON e.id=s.elder_id ORDER BY s.id DESC LIMIT ?",
                            (limit,))
            else:
                rows = service.list_symptoms(eid, limit)
            return self.json({"ok": True, "items": rows})

        if path == "/api/alerts":
            u = self.need()
            status = (qs.get("status") or [""])[0]
            if u["role"] == "elder":
                eid = self.need_elder(u)
                items = service.list_alerts(eid, status or "open")
            else:
                items = service.list_alerts(None, status or None)
            return self.json({"ok": True, "items": items})

        if path.startswith("/api/alerts/"):
            self.need()
            try:
                aid = int(path.rsplit("/", 1)[1])
            except ValueError:
                raise ApiError(400, "工单号无效")
            a = service.get_alert(aid)
            if not a:
                raise ApiError(404, "工单不存在")
            a["events"] = service.alert_events(aid)
            a["elder"] = service.elder_brief(a["elder_id"])
            a["calls"] = service.call_logs(aid)
            return self.json({"ok": True, "alert": a})

        if path == "/api/family/summary":
            u = self.need(("family",))
            eid = self.need_elder(u)
            c = service.consents(eid)
            prog = service.med_progress(eid)
            open_alerts = service.list_alerts(eid, "open")
            rep = service.report(eid, 7)
            if not c["share_health"]:
                # 老人撤回健康授权后，家属端不再返回血压与依从率
                rep = {"days": rep["days"], "adherence": None, "expected": None, "taken": None,
                       "vitals": [], "vital_count": None, "messages": rep["messages"],
                       "alerts": rep["alerts"], "sos": rep["sos"], "closed": rep["closed"],
                       "hidden": True}
            data = {
                "elder": service.elder_brief(eid),
                "profile": {k: (service.elder(eid) or {}).get(k) for k in
                            ("blood_type", "conditions", "allergies", "community", "address")},
                "med_progress": {"taken": prog["taken"], "total": prog["total"]},
                "meds": prog["items"],
                "open_alerts": open_alerts,
                "report": rep,
                "consents": c,
                "unread": service.unread_count(eid),
                "vital": service.latest_vital(eid) if c["share_health"] else None,
                "symptoms": service.list_symptoms(eid, 8),
                "last_activity": service.last_activity(eid),
                "heartbeat": service.heartbeat_status(eid),
            }
            return self.json({"ok": True, **data})

        if path == "/api/consents":
            u = self.need(("family", "elder"))
            eid = self.need_elder(u)
            return self.json({"ok": True, "consents": service.consents(eid)})

        if path == "/api/contacts":
            u = self.need(("elder", "family", "community", "admin"))
            eid = int((qs.get("elder_id") or ["0"])[0]) or self.need_elder(u)
            return self.json({"ok": True, "items": service.contacts(eid),
                              "voice_ready": notify.voice_ready()})

        if path == "/api/sms/config":
            self.need(("community", "admin"))
            return self.json({"ok": True, "config": sms.config(), "status": sms.status(),
                              "logs": sms.recent(12)})

        if path == "/api/console/bindcode":
            self.need(("community", "admin"))
            items = db.q(
                "SELECT b.id,b.code,b.role,b.expires_at,b.used_at,b.elder_id,e.name AS elder_name"
                " FROM bind_codes b JOIN elders e ON e.id=b.elder_id ORDER BY b.id DESC LIMIT 40")
            return self.json({"ok": True, "items": items})

        if path == "/api/notify":
            self.need(("community", "admin"))
            cfg = notify.get_config()
            return self.json({"ok": True, "config": cfg, "summary": notify.summary()})

        if path == "/api/console/duty":
            self.need(("community", "admin"))
            return self.json({"ok": True, "status": duty.status(), "runs": duty.recent(12)})

        if path == "/api/console/board":
            self.need(("community", "admin"))
            status = (qs.get("status") or [""])[0] or None
            return self.json({"ok": True, "items": service.list_alerts(None, status)})

        if path == "/api/console/roster":
            self.need(("community", "admin"))
            return self.json({"ok": True, "items": service.roster()})

        if path == "/api/console/metrics":
            self.need(("community", "admin"))
            return self.json({"ok": True, **service.metrics()})

        if path == "/api/console/elders":
            self.need(("community", "admin"))
            return self.json({"ok": True, "items": db.q(
                "SELECT id,name,age,address,conditions,device_status FROM elders ORDER BY id")})

        if path == "/api/console/users":
            self.need(("community", "admin"))
            items = db.q(
                "SELECT u.id,u.role,u.name,u.phone,u.elder_id,u.relation,u.verified,"
                "e.name AS elder_name"
                " FROM users u LEFT JOIN elders e ON e.id=u.elder_id ORDER BY u.role,u.id")
            for it in items:
                ok, reason, _p = sms.check_phone(it["phone"])
                it["phone_ok"] = ok
                it["phone_note"] = reason
            return self.json({"ok": True, "items": items})

        raise ApiError(404, "接口不存在")

    # ---------- 写接口 ----------

    def api_post(self, path, body):
        if path == "/api/setup":
            return self.api_setup(body)

        if path == "/api/auth/sms/send":
            return self.api_sms_send(body)

        if path == "/api/auth/register":
            return self.api_register(body)

        if path == "/api/auth/sms_login":
            return self.api_sms_login(body)

        if path == "/api/auth/reset":
            return self.api_reset(body)

        if path == "/api/auth/login":
            phone = body.get("phone") or ""
            pwd = body.get("password") or ""
            if self.too_many_fails(phone):
                raise ApiError(429, "密码错太多次了，请等 10 分钟，或改用短信验证码登录")
            r = auth.login(phone, pwd)
            if not r:
                self.note_fail(phone)
                raise ApiError(401, "手机号或密码不正确")
            token, user = r
            self.clear_fails(phone)
            secure = self.headers.get("X-Forwarded-Proto") == "https" or isinstance(
                self.connection, ssl.SSLSocket)
            log("[auth] 登录成功 %s（%s）" % (mask_phone(user["phone"]), user["role"]))
            return self.json({"ok": True, "user": user},
                             extra=[("Set-Cookie", auth.cookie_header(token, secure))])

        if path == "/api/auth/logout":
            cookie = auth.parse_cookies(self.headers.get("Cookie"))
            auth.logout(cookie.get(auth.SESSION_COOKIE))
            return self.json({"ok": True}, extra=[("Set-Cookie", auth.clear_cookie_header())])

        if path == "/api/auth/password":
            u = self.need()
            old = body.get("old") or ""
            new = body.get("new") or ""
            row = db.q1("SELECT * FROM users WHERE id=?", (u["id"],))
            if not auth.verify_password(old, row["pwd_hash"], row["pwd_salt"]):
                raise ApiError(400, "原密码不正确")
            if len(new) < 6:
                raise ApiError(400, "新密码至少 6 位")
            auth.set_password(u["id"], new)
            return self.json({"ok": True})

        if path == "/api/contacts":
            u = self.need(("family", "community", "admin"))
            eid = int(body.get("elder_id") or 0) or self.need_elder(u)
            r = service.add_contact(eid, body.get("name"), body.get("relation"),
                                    body.get("phone"), body.get("priority"),
                                    1 if body.get("can_call", True) else 0, body.get("note"))
            if not r["ok"]:
                raise ApiError(400, r.get("error", "添加失败"))
            return self.json({"ok": True, "id": r["id"], "items": service.contacts(eid)})

        if path.startswith("/api/contacts/"):
            u = self.need(("family", "community", "admin"))
            parts = path.strip("/").split("/")
            if len(parts) < 4:
                raise ApiError(400, "请求无效")
            cid = int(parts[2])
            action = parts[3]
            row = db.q1("SELECT * FROM elder_contacts WHERE id=?", (cid,))
            if not row:
                raise ApiError(404, "联系人不存在")
            eid = row["elder_id"]
            if action == "update":
                r = service.update_contact(eid, cid, **body)
            elif action == "delete":
                r = service.delete_contact(eid, cid)
            else:
                raise ApiError(404, "动作不存在")
            if not r["ok"]:
                raise ApiError(400, r.get("error", "操作失败"))
            return self.json({"ok": True, "items": service.contacts(eid)})

        if path == "/api/sms/config":
            self.need(("community", "admin"))
            sms.set_config(body)
            return self.json({"ok": True, "config": sms.config(), "status": sms.status()})

        if path == "/api/sms/test":
            self.need(("community", "admin"))
            return self.json(sms.test(body.get("phone") or ""))

        if path == "/api/console/bindcode":
            self.need(("community", "admin"))
            r = service.new_bind_code(int(body.get("elder_id") or 0),
                                      body.get("role") or "any", body.get("hours") or 72)
            if not r["ok"]:
                raise ApiError(400, r.get("error", "生成失败"))
            return self.json({"ok": True, **r})

        if path == "/api/meds":
            u = self.need(("family", "community", "admin"))
            eid = int(body.get("elder_id") or 0) or self.need_elder(u)
            r = service.add_med(eid, body.get("name"), body.get("dose"),
                                body.get("time"), body.get("meal"))
            if not r["ok"]:
                raise ApiError(400, r.get("error", "添加失败"))
            return self.json({"ok": True, "id": r["id"]})

        if path.startswith("/api/meds/") and path.endswith("/update"):
            u = self.need(("family", "community", "admin"))
            eid = self.need_elder(u)
            mid = int(path.split("/")[3])
            r = service.update_med(eid, mid, body.get("name"), body.get("dose"),
                                   body.get("time"), body.get("meal"))
            if not r["ok"]:
                raise ApiError(400, r.get("error", "保存失败"))
            return self.json({"ok": True})

        if path.startswith("/api/meds/") and path.endswith("/delete"):
            u = self.need(("family", "community", "admin"))
            eid = self.need_elder(u)
            mid = int(path.split("/")[3])
            r = service.deactivate_med(eid, mid)
            if not r["ok"]:
                raise ApiError(400, r.get("error", "删除失败"))
            return self.json({"ok": True})

        if path.startswith("/api/meds/") and path.endswith("/confirm"):
            u = self.need(("elder", "family"))
            eid = self.need_elder(u)
            med_id = int(path.split("/")[3])
            r = service.confirm_med(eid, med_id, source="elder" if u["role"] == "elder" else "family")
            if not r["ok"]:
                raise ApiError(400, r.get("error", "确认失败"))
            return self.json({"ok": True, "progress": service.med_progress(eid)})

        if path == "/api/vitals":
            u = self.need(("elder", "family"))
            eid = self.need_elder(u)
            r = service.add_vital(eid, body.get("sys"), body.get("dia"), body.get("pulse"), source=u["role"])
            if not r["ok"]:
                raise ApiError(400, r.get("error", "记录失败"))
            return self.json({"ok": True, "vital": r})

        if path == "/api/elder/heartbeat":
            u = self.need(("elder",))
            eid = self.need_elder(u)
            ip = self.client_address[0] if self.client_address else ""
            return self.json(service.heartbeat(eid, body.get("path") or "", ip))

        if path == "/api/elder/watch":
            u = self.need(("elder", "family"))
            eid = self.need_elder(u)
            on = bool(body.get("enabled"))
            r = service.set_watch(eid, on)
            r["heartbeat"] = service.heartbeat_status(eid)
            return self.json(r)

        if path == "/api/notify/config":
            self.need(("community", "admin"))
            if body.get("voice"):
                v = body["voice"] or {}
                notify.set_voice(v.get("ak_id"), v.get("ak_secret"),
                                 v.get("called"), v.get("tts_code"))
            if body.get("channel"):
                notify.set_config(body["channel"], body.get("value") or "")
            return self.json({"ok": True, "config": notify.get_config()})

        if path == "/api/notify/test":
            self.need(("community", "admin"))
            return self.json(notify.test_all())

        if path == "/api/sos":
            u = self.need(("elder", "family"))
            eid = self.need_elder(u)
            reason = (body.get("reason") or "老人按下求助按钮").strip()[:80]
            aid = service.create_alert(eid, "sos", "紧急求助：" + reason,
                                       "由%s发起，已启动三级联动。" % ("老人端" if u["role"] == "elder" else "家属端"),
                                       source="sos")
            log("[alert] SOS #%s %s" % (aid, reason))
            return self.json({"ok": True, "alert_id": aid,
                              "sla_seconds": jobs.SOS_ESCALATE_1})

        if path == "/api/chat":
            u = self.need(("elder",))
            eid = self.need_elder(u)
            r = ai.chat(eid, body.get("text") or "")
            if not r["ok"]:
                raise ApiError(400, r.get("error", "对话失败"))
            return self.json(r)

        if path == "/api/messages":
            u = self.need(("family", "community", "admin", "elder"))
            eid = int(body.get("elder_id") or 0) or self.need_elder(u)
            r = service.add_message(eid, u, body.get("text"))
            if not r["ok"]:
                raise ApiError(400, r.get("error", "发送失败"))
            return self.json({"ok": True, "id": r["id"]})

        if path == "/api/messages/read":
            u = self.need(("elder",))
            eid = self.need_elder(u)
            service.mark_messages_read(eid)
            return self.json({"ok": True})

        if path == "/api/console/duty":
            self.need(("community", "admin"))
            on = bool(body.get("enabled"))
            duty.set_enabled(on)
            done = duty.process_pending() if on else []
            return self.json({"ok": True, "status": duty.status(), "handled": done})

        if path == "/api/console/duty/run":
            self.need(("community", "admin"))
            if not duty.enabled():
                raise ApiError(400, "AI 值守还没打开")
            return self.json({"ok": True, "handled": duty.process_pending(5),
                              "status": duty.status()})

        if path.startswith("/api/alerts/"):
            u = self.need(("community", "admin", "family"))
            parts = path.strip("/").split("/")
            if len(parts) < 4:
                raise ApiError(400, "请求无效")
            aid = int(parts[2])
            action = parts[3]
            if action == "accept":
                r = service.accept_alert(aid, u)
            elif action == "arrive":
                r = service.arrive_alert(aid, u)
            elif action == "close":
                r = service.close_alert(aid, u, (body.get("note") or "已确认安全")[:80])
            elif action == "reopen":
                r = service.reopen_alert(aid, u, (body.get("note") or "重新打开")[:60])
            elif action == "note":
                text = (body.get("text") or "").strip()
                if not text:
                    raise ApiError(400, "备注不能为空")
                service.add_event(aid, text[:120], u["name"])
                r = {"ok": True}
            else:
                raise ApiError(404, "动作不存在")
            if not r["ok"]:
                raise ApiError(400, r.get("error", "操作失败"))
            a = service.get_alert(aid)
            a["events"] = service.alert_events(aid)
            return self.json({"ok": True, "alert": a})

        if path == "/api/consents":
            u = self.need(("family", "elder"))
            eid = self.need_elder(u)
            c = service.set_consents(eid, **{k: body[k] for k in
                                             ("share_health", "radar", "location") if k in body})
            return self.json({"ok": True, "consents": c})

        if path == "/api/llm/config":
            self.need(("community", "admin"))
            ai.set_llm(body.get("api_key"), body.get("base_url"), body.get("model"))
            return self.json({"ok": True, "status": ai.status()})

        if path == "/api/llm/test":
            self.need(("community", "admin"))
            if not ai.status()["configured"]:
                raise ApiError(400, "还没有填 API Key")
            row = db.q1("SELECT id FROM elders ORDER BY id LIMIT 1")
            if not row:
                raise ApiError(400, "还没有老人档案")
            t0 = time.time()
            obj, mode = ai.ask_llm(row["id"], "请用一句话回复：我在。")
            ms = int((time.time() - t0) * 1000)
            if mode != "llm":
                msg = (ai.LAST_ERROR.get("message") or "").strip()
                raise ApiError(400, msg or ("调用失败（%s）" % mode))
            return self.json({"ok": True, "latency_ms": ms,
                              "model": ai.status()["model"],
                              "reply": (obj or {}).get("reply", "")})

        if path == "/api/llm/clear":
            self.need(("community", "admin"))
            ai.clear_llm()
            return self.json({"ok": True, "status": ai.status()})

        if path == "/api/users":
            self.need(("community", "admin"))
            role = body.get("role")
            if role not in ("elder", "family", "community"):
                raise ApiError(400, "角色无效")
            phone = (body.get("phone") or "").strip()
            pwd = body.get("password") or ""
            if not phone or len(pwd) < 6:
                raise ApiError(400, "手机号必填，密码至少 6 位")
            p_ok, p_reason, phone = sms.check_phone(phone)
            if not p_ok:
                raise ApiError(400, p_reason)
            if db.q1("SELECT id FROM users WHERE phone=?", (phone,)):
                raise ApiError(400, "这个手机号已经注册过了")
            uid = auth.create_user(role, (body.get("name") or "成员").strip(), phone, pwd,
                                   elder_id=body.get("elder_id"), relation=body.get("relation"))
            if body.get("elder_id"):
                service.ensure_contacts(int(body["elder_id"]))
            return self.json({"ok": True, "user_id": uid})

        if path == "/api/users/reset":
            self.need(("community", "admin"))
            phone = (body.get("phone") or "").strip()
            pwd = body.get("password") or ""
            if len(pwd) < 6:
                raise ApiError(400, "新密码至少 6 位")
            u = db.q1("SELECT id FROM users WHERE phone=?", (phone,))
            if not u:
                raise ApiError(404, "没有这个手机号")
            auth.set_password(u["id"], pwd)
            return self.json({"ok": True})

        if path == "/api/elders":
            self.need(("community", "admin"))
            e = body.get("elder") or {}
            if not (e.get("name") or "").strip():
                raise ApiError(400, "老人姓名不能为空")
            eid = db.ex(
                "INSERT INTO elders(name,display,age,address,blood_type,conditions,allergies,"
                "community,device_status,created_at) VALUES(?,?,?,?,?,?,?,?,'online',?)",
                (e.get("name"), e.get("display") or e.get("name"), e.get("age"),
                 e.get("address"), e.get("blood_type"), e.get("conditions"),
                 e.get("allergies"), e.get("community"), db.now()))
            service.ensure_consents(eid)
            return self.json({"ok": True, "elder_id": eid})

        raise ApiError(404, "接口不存在")

    # ---------- 短信验证码 ----------

    def api_sms_send(self, body):
        phone = (body.get("phone") or "").strip()
        scene = (body.get("scene") or "register").strip()
        if scene not in ("register", "login", "reset"):
            raise ApiError(400, "场景无效")
        ok, reason = sms.check_captcha(body.get("captcha_token"), body.get("captcha"))
        if not ok:
            raise ApiError(400, reason)
        p_ok, p_reason, p = sms.check_phone(phone)
        if not p_ok:
            raise ApiError(400, p_reason)
        exists = bool(auth.user_by_phone(p))
        if scene == "register" and exists:
            raise ApiError(400, "这个手机号已经注册过了，直接登录即可")
        if scene in ("login", "reset") and not exists:
            raise ApiError(400, "这个手机号还没有注册，请先注册")
        r = sms.send_code(p, scene, self.client_ip())
        if not r.get("ok"):
            raise ApiError(400, r.get("error") or "发送失败")
        log("[sms] %s 向 %s 发送%s验证码（%s）" %
            (self.client_ip(), p[:3] + "****" + p[-4:], {"register": "注册", "login": "登录",
                                                          "reset": "重置"}[scene], r["channel"]))
        return self.json(r)

    def api_register(self, body):
        phone = sms.normalize(body.get("phone"))
        role = (body.get("role") or "family").strip()
        pwd = body.get("password") or ""
        p_ok, p_reason, p = sms.check_phone(phone)
        if not p_ok:
            raise ApiError(400, p_reason)
        if len(pwd) < 6:
            raise ApiError(400, "密码至少 6 位")
        if auth.user_by_phone(p):
            raise ApiError(400, "这个手机号已经注册过了，直接登录即可")
        ok, reason = sms.verify_code(p, "register", body.get("code"))
        if not ok:
            raise ApiError(400, reason)
        r = auth.register(role, body.get("name"), p, pwd,
                          invite=(body.get("invite") or "").strip(),
                          elder=body.get("elder") or {},
                          relation=body.get("relation") or "")
        if not r.get("ok"):
            raise ApiError(400, r.get("error") or "注册失败")
        user = r["user"]
        secure = self.headers.get("X-Forwarded-Proto") == "https" or isinstance(
            self.connection, ssl.SSLSocket)
        log("[auth] 新注册 %s（%s，%s）绑定老人 #%s" %
            (mask_phone(user["phone"]), user["name"], user["role"], r.get("elder_id")))
        return self.json({"ok": True, "user": user, "elder_id": r.get("elder_id")},
                         extra=[("Set-Cookie", auth.cookie_header(r["token"], secure))])

    def api_sms_login(self, body):
        phone = sms.normalize(body.get("phone"))
        ok, reason = sms.verify_code(phone, "login", body.get("code"))
        if not ok:
            raise ApiError(400, reason)
        r = auth.login_verified(phone)
        if not r:
            raise ApiError(404, "这个手机号还没有注册")
        token, user = r
        secure = self.headers.get("X-Forwarded-Proto") == "https" or isinstance(
            self.connection, ssl.SSLSocket)
        log("[auth] 验证码登录 %s（%s）" % (mask_phone(user["phone"]), user["role"]))
        return self.json({"ok": True, "user": user},
                         extra=[("Set-Cookie", auth.cookie_header(token, secure))])

    def api_reset(self, body):
        phone = sms.normalize(body.get("phone"))
        pwd = body.get("password") or ""
        if len(pwd) < 6:
            raise ApiError(400, "新密码至少 6 位")
        u = auth.user_by_phone(phone)
        if not u:
            raise ApiError(404, "这个手机号还没有注册")
        ok, reason = sms.verify_code(phone, "reset", body.get("code"))
        if not ok:
            raise ApiError(400, reason)
        auth.set_password(u["id"], pwd)
        db.ex("DELETE FROM sessions WHERE user_id=?", (u["id"],))
        log("[auth] %s 通过短信验证重置了密码" % mask_phone(phone))
        return self.json({"ok": True})

    # ---------- 首次初始化 ----------

    def api_setup(self, body):
        if db.has_users():
            raise ApiError(400, "系统已初始化，请直接登录")
        elder = body.get("elder") or {}
        if not (elder.get("name") or "").strip():
            raise ApiError(400, "请填写老人姓名")
        elder_login = body.get("elder_login") or {}
        family = body.get("family") or {}
        community = body.get("community") or {}

        for label, acc in (("老人", elder_login), ("家属", family), ("社区", community)):
            if not (acc.get("phone") or "").strip():
                raise ApiError(400, "请填写%s账号的手机号" % label)
            if len(acc.get("password") or "") < 6:
                raise ApiError(400, "%s账号密码至少 6 位" % label)
            p_ok, p_reason, _p = sms.check_phone(acc["phone"])
            if not p_ok:
                raise ApiError(400, "%s账号：%s" % (label, p_reason))
        phones = [elder_login["phone"], family["phone"], community["phone"]]
        if len(set(p.strip() for p in phones)) != 3:
            raise ApiError(400, "三个账号的手机号不能重复")

        eid = db.ex(
            "INSERT INTO elders(name,display,age,address,blood_type,conditions,allergies,"
            "community,device_status,created_at) VALUES(?,?,?,?,?,?,?,?,'online',?)",
            ((elder.get("name") or "").strip(), (elder.get("display") or elder.get("name")).strip(),
             elder.get("age"), elder.get("address"), elder.get("blood_type"),
             elder.get("conditions"), elder.get("allergies"), elder.get("community"), db.now()))
        service.ensure_consents(eid)

        for m in (body.get("meds") or []):
            if not (m.get("name") or "").strip() or not (m.get("time") or "").strip():
                continue
            db.ex("INSERT INTO meds(elder_id,name,dose,time_hhmm,meal,active,created_at)"
                   " VALUES(?,?,?,?,?,1,?)",
                   (eid, m["name"].strip(), m.get("dose") or "1 片", m["time"], m.get("meal"), db.now()))

        auth.create_user("elder", (elder.get("name") or "").strip(), elder_login["phone"],
                         elder_login["password"], elder_id=eid)
        auth.create_user("family", (family.get("name") or "").strip(), family["phone"],
                         family["password"], elder_id=eid, relation=family.get("relation") or "家属")
        auth.create_user("community", (community.get("name") or "").strip(), community["phone"],
                         community["password"], elder_id=eid, relation="网格员")
        log("[setup] 初始化完成：老人 #%s，三类账号已创建" % eid)
        return self.json({"ok": True, "elder_id": eid})


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:
        pass
    return sorted(ips)


def main():
    config.load()
    db.init()
    jobs.start()

    host = config.get()["server"]["host"]
    http_port = int(config.get()["server"]["http_port"])
    https_port = int(config.get()["server"]["https_port"])

    httpd = ThreadingHTTPServer((host, http_port), Handler)
    httpd.daemon_threads = True

    httpsd = None
    cert = os.path.join(ROOT, "certs", "anyu.crt")
    key = os.path.join(ROOT, "certs", "anyu.key")
    if os.path.exists(cert) and os.path.exists(key):
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            httpsd = ThreadingHTTPServer((host, https_port), Handler)
            httpsd.socket = ctx.wrap_socket(httpsd.socket, server_side=True)
            httpsd.daemon_threads = True
        except Exception as ex:
            log("[https] 启动失败：%s" % ex)

    log("")
    log("  安语 · 居家养老语音助手")
    log("  ----------------------------------------")
    log("  本机：  http://127.0.0.1:%d/" % http_port)
    for ip in lan_ips():
        log("  局域网：http://%s:%d/" % (ip, http_port))
    if httpsd:
        for ip in lan_ips():
            log("  手机：  https://%s:%d/   （自签名证书，需点继续访问）" % (ip, https_port))
    else:
        log("  提示：  未找到 app/certs 证书，手机端麦克风需要 HTTPS（见 README）")
    log("  数据库：%s" % config.db_path())
    log("  初始化：%s" % ("已完成，请登录" if db.has_users() else "首次打开会自动进入设置向导"))
    log("")

    if httpsd:
        threading.Thread(target=httpsd.serve_forever, name="https", daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("\n正在关闭……")
    finally:
        jobs.stop()
        httpd.server_close()
        if httpsd:
            httpsd.server_close()


if __name__ == "__main__":
    main()
