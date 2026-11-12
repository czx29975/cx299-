"""账号与会话：PBKDF2 密码、服务端会话、Cookie 解析。"""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta

import db

SESSION_COOKIE = "anyu_session"
SESSION_DAYS = 30
ITERATIONS = 180_000


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), ITERATIONS)
    return dk.hex(), salt


def verify_password(password, pwd_hash, salt):
    calc = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), ITERATIONS)
    return hmac.compare_digest(calc.hex(), pwd_hash)


PUBLIC_FIELDS = ("id", "role", "name", "phone", "elder_id", "relation")


def _public(u):
    d = {k: u.get(k) for k in PUBLIC_FIELDS}
    d["verified"] = bool(u.get("verified"))
    return d


def _new_session(user_id):
    token = secrets.token_urlsafe(32)
    expires = (datetime.now() + timedelta(days=SESSION_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    db.ex("INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)",
          (token, user_id, db.now(), expires))
    return token


def create_user(role, name, phone, password, elder_id=None, relation=None, verified=0):
    pwd_hash, salt = hash_password(password)
    return db.ex(
        "INSERT INTO users(role,name,phone,pwd_hash,pwd_salt,elder_id,relation,created_at,"
        "verified,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (role, name, phone.strip(), pwd_hash, salt, elder_id, relation, db.now(),
         verified, db.now() if verified else None),
    )


def set_password(user_id, password):
    pwd_hash, salt = hash_password(password)
    db.ex("UPDATE users SET pwd_hash=?, pwd_salt=? WHERE id=?", (pwd_hash, salt, user_id))


def user_by_phone(phone):
    return db.q1("SELECT * FROM users WHERE phone=?", ((phone or "").strip(),))


def login(phone, password):
    u = user_by_phone(phone)
    if not u or not verify_password(password or "", u["pwd_hash"], u["pwd_salt"]):
        return None
    return _new_session(u["id"]), _public(u)


def login_verified(phone):
    """短信验证码登录：验证码已经在 sms.verify_code 里校验过，这里只建会话。"""
    u = user_by_phone(phone)
    if not u:
        return None
    return _new_session(u["id"]), _public(u)


def register(role, name, phone, password, invite="", elder=None, relation=""):
    """自助注册。必须已经通过短信验证码校验（前端先调 /api/auth/sms/send + register 里带 code）。

    绑定老人有两种方式，都是为了不让陌生人认领别人的老人：
      1) 社区发放的 6 位绑定码；
      2) 家属代为新建档案（自己填老人信息，档案归属该家属）。
    """
    import sms
    import service

    if role not in ("elder", "family"):
        return {"ok": False, "error": "只能注册老人或家属账号"}
    name = (name or "").strip()
    if len(name) < 2:
        return {"ok": False, "error": "请填写真实姓名（至少 2 个字）"}
    ok, reason, phone = sms.check_phone(phone)
    if not ok:
        return {"ok": False, "error": reason}
    if len(password or "") < 6:
        return {"ok": False, "error": "密码至少 6 位"}
    if user_by_phone(phone):
        return {"ok": False, "error": "这个手机号已经注册过了，直接登录即可"}

    elder_id = None
    code_row = None
    if invite:
        code_row = db.q1("SELECT * FROM bind_codes WHERE code=? AND used_at IS NULL"
                         " ORDER BY id DESC LIMIT 1", (invite.strip().upper(),))
        if not code_row:
            return {"ok": False, "error": "绑定码无效或已被使用，请向社区重新索取"}
        if code_row["expires_at"] < db.now():
            return {"ok": False, "error": "绑定码已过期，请向社区重新索取"}
        if code_row["role"] and code_row["role"] not in ("any", role):
            return {"ok": False, "error": "这个绑定码是发给%s的，请选择对应身份" %
                    ("家属" if code_row["role"] == "family" else "老人")}
        elder_id = code_row["elder_id"]
    else:
        e = elder or {}
        ename = (e.get("name") or "").strip()
        if len(ename) < 2:
            return {"ok": False, "error": "请填写老人姓名，或使用社区发放的绑定码"}
        elder_id = db.ex(
            "INSERT INTO elders(name,display,age,address,blood_type,conditions,allergies,"
            "community,device_status,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?)",
            (ename, (e.get("display") or ename).strip(), e.get("age") or None,
             (e.get("address") or "").strip() or None, e.get("blood_type"),
             e.get("conditions"), e.get("allergies"), (e.get("community") or "").strip() or None,
             db.now()))
        service.ensure_consents(elder_id)

    uid = create_user(role, name, phone, password, elder_id=elder_id,
                      relation=(relation or "").strip() or ("本人" if role == "elder" else "家属"),
                      verified=1)
    if code_row:
        db.ex("UPDATE bind_codes SET used_at=?, used_by=? WHERE id=?",
              (db.now(), uid, code_row["id"]))
    service.ensure_contacts(elder_id)
    u = db.q1("SELECT * FROM users WHERE id=?", (uid,))
    return {"ok": True, "user": _public(u), "elder_id": elder_id, "token": _new_session(uid)}


def mark_verified(user_id):
    db.ex("UPDATE users SET verified=1, verified_at=? WHERE id=?", (db.now(), user_id))


def logout(token):
    if token:
        db.ex("DELETE FROM sessions WHERE token=?", (token,))


def user_from_token(token):
    if not token:
        return None
    row = db.q1(
        "SELECT u.id,u.role,u.name,u.phone,u.elder_id,u.relation,u.verified,s.expires_at"
        " FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?",
        (token,),
    )
    if not row:
        return None
    if row["expires_at"] < db.now():
        db.ex("DELETE FROM sessions WHERE token=?", (token,))
        return None
    row.pop("expires_at", None)
    return row


def parse_cookies(header):
    out = {}
    for part in (header or "").split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def cookie_header(token, secure=False):
    parts = [
        "%s=%s" % (SESSION_COOKIE, token),
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=%d" % (SESSION_DAYS * 86400),
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie_header():
    return "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" % SESSION_COOKIE
