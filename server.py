#!/usr/bin/env python3
"""
ระบบเช็คลิสต์งานพนักงาน (Task Checklist)
ใช้แค่ Python มาตรฐาน ไม่ต้องติดตั้งอะไรเพิ่ม

รัน:  python server.py
เปิด: http://localhost:8000
"""
import base64
import hashlib
import json
import mimetypes
import os
import re
import secrets
import socket
import sqlite3
import time
import traceback
from contextlib import contextmanager
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

# ---------------- ตั้งค่า ----------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# ที่เก็บข้อมูล: บนคลาวด์ให้ชี้ไปที่ดิสก์ถาวร (Railway ตั้ง RAILWAY_VOLUME_MOUNT_PATH ให้อัตโนมัติ)
DATA_DIR = os.environ.get("DATA_DIR") or os.environ.get("RAILWAY_VOLUME_MOUNT_PATH") or BASE_DIR
DB_PATH = os.path.join(DATA_DIR, "data.db")          # ฐานข้อมูล
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")       # รูปที่พนักงานอัปโหลด
PUBLIC_DIR = os.path.join(BASE_DIR, "public")        # หน้าเว็บ
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
SESSION_SECONDS = 7 * 24 * 3600                      # อยู่ในระบบได้ 7 วัน
MAX_BODY = 20 * 1024 * 1024                          # ขนาดข้อมูลสูงสุดต่อคำขอ

# บัญชีเริ่มต้น (สร้างครั้งแรกที่ยังไม่มีผู้ใช้) — เปลี่ยนรหัสหลังเข้าใช้ครั้งแรก
# บนคลาวด์ให้ตั้ง ADMIN_PASSWORD: จะสร้างแค่บัญชี admin ด้วยรหัสนั้น ไม่มีบัญชี/งานตัวอย่าง
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "").strip()
if ADMIN_PASSWORD:
    DEFAULT_USERS = [("admin", ADMIN_PASSWORD, "นายจ้าง", "employer")]
else:
    DEFAULT_USERS = [
        ("admin", "admin123", "นายจ้าง", "employer"),
        ("staff1", "1234", "พนักงาน 1", "employee"),
    ]

ROLE_TH = {"employer": "นายจ้าง", "employee": "พนักงาน"}


def now():
    return int(time.time())


def hash_password(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200_000).hex()
    return f"{salt}${h}"


def check_password(pw, stored):
    salt = stored.split("$", 1)[0]
    return secrets.compare_digest(hash_password(pw, salt), stored)


@contextmanager
def db():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employer', 'employee')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  zone TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',      -- todo | submitted | done
  photo TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  reject_note TEXT NOT NULL DEFAULT '',
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at INTEGER,
  approved_at INTEGER,
  created_at INTEGER NOT NULL
);
-- งานที่เคยเพิ่ม (เก็บแยกจากงานจริง ลบงานแล้วรายการนี้ยังอยู่)
CREATE TABLE IF NOT EXISTS task_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  zone TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER NOT NULL
);
"""

TEMPLATE_SELECT = """
SELECT tp.*, a.name AS assignee_name FROM task_templates tp
LEFT JOIN users a ON a.id = tp.assigned_to
"""


def remember_template(con, title, zone, detail, assigned_to, ts):
    """บันทึกงานลงรายการ "งานที่เคยเพิ่ม" (ถ้ามีงานเดียวกันอยู่แล้ว จะนับเพิ่ม)"""
    key = "|".join(s.strip().lower() for s in (title, zone, detail))
    con.execute(
        "INSERT INTO task_templates (key, title, zone, detail, assigned_to, use_count, last_used_at) "
        "VALUES (?,?,?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET "
        "title=excluded.title, zone=excluded.zone, detail=excluded.detail, assigned_to=excluded.assigned_to, "
        "use_count=use_count+1, last_used_at=excluded.last_used_at",
        (key, title, zone, detail, assigned_to, ts))

TASK_SELECT = """
SELECT t.*, a.name AS assignee_name, s.name AS submitter_name
FROM tasks t
LEFT JOIN users a ON a.id = t.assigned_to
LEFT JOIN users s ON s.id = t.submitted_by
"""


def init_db():
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    with db() as con:
        had_templates = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_templates'").fetchone()
        con.executescript(SCHEMA)
        if not had_templates:
            # ฐานข้อมูลเดิม: นำงานที่มีอยู่แล้วมาใส่ในรายการ "งานที่เคยเพิ่ม"
            for t in con.execute("SELECT * FROM tasks ORDER BY created_at, id").fetchall():
                remember_template(con, t["title"], t["zone"], t["detail"], t["assigned_to"], t["created_at"])
        if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            for username, pw, name, role in DEFAULT_USERS:
                con.execute(
                    "INSERT INTO users (username, password, name, role, created_at) VALUES (?,?,?,?,?)",
                    (username, hash_password(pw), name, role, now()),
                )
            staff_row = con.execute("SELECT id FROM users WHERE username='staff1'").fetchone()
            staff = staff_row[0] if staff_row else None
            samples = [] if ADMIN_PASSWORD else [
                ("ทำความสะอาดห้องน้ำ", "โซน A ชั้น 1", "ขัดพื้น เช็ดกระจก เติมสบู่และกระดาษ", staff),
                ("ถูพื้นล็อบบี้", "โซน B ล็อบบี้", "ถูพื้นให้แห้ง วางป้ายพื้นเปียก", staff),
                ("เก็บขยะรอบอาคาร", "โซน C ลานจอดรถ", "", None),
            ]
            for title, zone, detail, assigned in samples:
                con.execute(
                    "INSERT INTO tasks (title, zone, detail, assigned_to, created_at) VALUES (?,?,?,?,?)",
                    (title, zone, detail, assigned, now()),
                )
                remember_template(con, title, zone, detail, assigned, now())


def save_photo(data_url, task_id):
    m = re.fullmatch(r"data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)", data_url or "")
    if not m:
        raise ApiError(400, "กรุณาแนบรูปภาพ")
    ext = "jpg" if m.group(1) in ("jpeg", "jpg") else m.group(1)
    name = f"task{task_id}_{now()}_{secrets.token_hex(4)}.{ext}"
    with open(os.path.join(UPLOAD_DIR, name), "wb") as f:
        f.write(base64.b64decode(m.group(2)))
    return name


def remove_photo(name):
    if name:
        try:
            os.remove(os.path.join(UPLOAD_DIR, name))
        except OSError:
            pass


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
                 ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


class Handler(BaseHTTPRequestHandler):
    server_version = "TaskChecklist/1.0"

    # ---------- พื้นฐาน ----------
    def do_GET(self): self.dispatch("GET")
    def do_POST(self): self.dispatch("POST")
    def do_PUT(self): self.dispatch("PUT")
    def do_DELETE(self): self.dispatch("DELETE")

    def dispatch(self, method):
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                return self.handle_api(method, path)
            if method != "GET":
                raise ApiError(405, "Method not allowed")
            if path.startswith("/uploads/"):
                return self.serve_upload(path)
            return self.serve_static(path)
        except ApiError as e:
            self.send_json(e.code, {"error": e.msg})
        except (ValueError, TypeError):
            self.send_json(400, {"error": "ข้อมูลไม่ถูกต้อง"})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "เกิดข้อผิดพลาดในระบบ"})

    def send_json(self, code, obj, headers=()):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, full, cache="no-cache"):
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ApiError(413, "ไฟล์ใหญ่เกินไป")
        if n == 0:
            return {}
        data = json.loads(self.rfile.read(n))
        if not isinstance(data, dict):
            raise ValueError
        return data

    def current_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        sid = cookie.get("sid")
        if not sid:
            return None
        with db() as con:
            r = con.execute(
                "SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token = ? AND s.expires_at > ?", (sid.value, now())).fetchone()
        return dict(r) if r else None

    @staticmethod
    def need(user, role):
        if user["role"] != role:
            raise ApiError(403, f"เฉพาะ{ROLE_TH[role]}เท่านั้น")
        return user

    # ---------- ไฟล์ ----------
    def serve_static(self, path):
        rel = unquote(path).lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        if not full.startswith(PUBLIC_DIR + os.sep) or not os.path.isfile(full):
            raise ApiError(404, "ไม่พบหน้า")
        self.send_file(full)

    def serve_upload(self, path):
        if not self.current_user():
            raise ApiError(401, "กรุณาเข้าสู่ระบบ")
        name = unquote(path[len("/uploads/"):])
        if not re.fullmatch(r"[\w.-]+", name):
            raise ApiError(404, "ไม่พบไฟล์")
        full = os.path.join(UPLOAD_DIR, name)
        if not os.path.isfile(full):
            raise ApiError(404, "ไม่พบไฟล์")
        self.send_file(full, cache="private, max-age=86400")

    # ---------- API ----------
    def handle_api(self, method, path):
        if method == "POST" and path == "/api/login":
            return self.api_login()
        if method == "POST" and path == "/api/logout":
            return self.api_logout()

        u = self.current_user()
        if not u:
            raise ApiError(401, "กรุณาเข้าสู่ระบบ")

        if method == "GET" and path == "/api/me":
            return self.send_json(200, u)
        if method == "POST" and path == "/api/me/password":
            return self.api_change_password(u)

        if path == "/api/tasks":
            if method == "GET":
                return self.api_list_tasks(u)
            if method == "POST":
                return self.api_create_task(self.need(u, "employer"))

        m = re.fullmatch(r"/api/tasks/(\d+)(?:/(submit|approve|reject|undo))?", path)
        if m:
            tid, action = int(m.group(1)), m.group(2)
            if action is None and method == "PUT":
                return self.api_update_task(self.need(u, "employer"), tid)
            if action is None and method == "DELETE":
                return self.api_delete_task(self.need(u, "employer"), tid)
            if action == "submit" and method == "POST":
                return self.api_submit(self.need(u, "employee"), tid)
            if action in ("approve", "reject", "undo") and method == "POST":
                return self.api_review(self.need(u, "employer"), tid, action)

        if path == "/api/templates" and method == "GET":
            return self.api_list_templates(self.need(u, "employer"))
        m = re.fullmatch(r"/api/templates/(\d+)", path)
        if m and method == "DELETE":
            return self.api_delete_template(self.need(u, "employer"), int(m.group(1)))

        if path == "/api/users":
            if method == "GET":
                return self.api_list_users(self.need(u, "employer"))
            if method == "POST":
                return self.api_create_user(self.need(u, "employer"))
        m = re.fullmatch(r"/api/users/(\d+)", path)
        if m and method == "DELETE":
            return self.api_delete_user(self.need(u, "employer"), int(m.group(1)))

        raise ApiError(404, "ไม่พบ API")

    # --- เข้าสู่ระบบ ---
    def api_login(self):
        d = self.body()
        username = str(d.get("username", "")).strip()
        password = str(d.get("password", ""))
        role = d.get("role")
        with db() as con:
            r = con.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
            if not r or not check_password(password, r["password"]):
                raise ApiError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง")
            if role in ROLE_TH and r["role"] != role:
                raise ApiError(403, f"บัญชีนี้ไม่ใช่บัญชี{ROLE_TH[role]} กรุณาเลือกแท็บ{ROLE_TH[r['role']]}")
            token = secrets.token_urlsafe(32)
            con.execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
            con.execute("INSERT INTO sessions VALUES (?,?,?)", (token, r["id"], now() + SESSION_SECONDS))
        user = {"id": r["id"], "username": r["username"], "name": r["name"], "role": r["role"]}
        cookie = f"sid={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS}"
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            cookie += "; Secure"  # บนคลาวด์ที่เป็น https
        self.send_json(200, user, [("Set-Cookie", cookie)])

    def api_logout(self):
        sid = SimpleCookie(self.headers.get("Cookie", "")).get("sid")
        if sid:
            with db() as con:
                con.execute("DELETE FROM sessions WHERE token = ?", (sid.value,))
        self.send_json(200, {"ok": True}, [("Set-Cookie", "sid=; Path=/; HttpOnly; Max-Age=0")])

    def api_change_password(self, u):
        d = self.body()
        old, new = str(d.get("old_password", "")), str(d.get("new_password", ""))
        if len(new) < 4:
            raise ApiError(400, "รหัสผ่านใหม่ต้องยาวอย่างน้อย 4 ตัวอักษร")
        with db() as con:
            r = con.execute("SELECT password FROM users WHERE id = ?", (u["id"],)).fetchone()
            if not check_password(old, r["password"]):
                raise ApiError(400, "รหัสผ่านเดิมไม่ถูกต้อง")
            con.execute("UPDATE users SET password = ? WHERE id = ?", (hash_password(new), u["id"]))
        self.send_json(200, {"ok": True})

    # --- งาน ---
    def get_task(self, con, tid):
        r = con.execute(TASK_SELECT + " WHERE t.id = ?", (tid,)).fetchone()
        if not r:
            raise ApiError(404, "ไม่พบงานนี้")
        return dict(r)

    def api_list_tasks(self, u):
        with db() as con:
            if u["role"] == "employer":
                rows = con.execute(TASK_SELECT + " ORDER BY t.id DESC").fetchall()
            else:
                rows = con.execute(TASK_SELECT + " WHERE t.assigned_to = ? OR t.assigned_to IS NULL "
                                   "ORDER BY t.id DESC", (u["id"],)).fetchall()
        self.send_json(200, [dict(r) for r in rows])

    def task_fields(self, con, d):
        title = str(d.get("title", "")).strip()
        if not title:
            raise ApiError(400, "กรุณาใส่ชื่องาน")
        assigned = d.get("assigned_to") or None
        if assigned is not None:
            assigned = int(assigned)
            if not con.execute("SELECT 1 FROM users WHERE id = ? AND role = 'employee'", (assigned,)).fetchone():
                raise ApiError(400, "ไม่พบพนักงานที่เลือก")
        due = str(d.get("due_date", "")).strip()
        if due and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", due):
            raise ApiError(400, "รูปแบบวันที่ไม่ถูกต้อง")
        return (title[:200], str(d.get("zone", "")).strip()[:100],
                str(d.get("detail", "")).strip()[:2000], assigned, due)

    def api_create_task(self, u):
        d = self.body()
        with db() as con:
            f = self.task_fields(con, d)
            cur = con.execute("INSERT INTO tasks (title, zone, detail, assigned_to, due_date, created_at) "
                              "VALUES (?,?,?,?,?,?)", (*f, now()))
            remember_template(con, f[0], f[1], f[2], f[3], now())
            task = self.get_task(con, cur.lastrowid)
        self.send_json(201, task)

    def api_update_task(self, u, tid):
        d = self.body()
        with db() as con:
            self.get_task(con, tid)
            f = self.task_fields(con, d)
            con.execute("UPDATE tasks SET title=?, zone=?, detail=?, assigned_to=?, due_date=? WHERE id=?", (*f, tid))
            task = self.get_task(con, tid)
        self.send_json(200, task)

    def api_delete_task(self, u, tid):
        with db() as con:
            t = self.get_task(con, tid)
            con.execute("DELETE FROM tasks WHERE id = ?", (tid,))
        remove_photo(t["photo"])
        self.send_json(200, {"ok": True})

    def api_submit(self, u, tid):
        d = self.body()
        with db() as con:
            t = self.get_task(con, tid)
            if t["assigned_to"] not in (None, u["id"]):
                raise ApiError(404, "ไม่พบงานนี้")
            if t["status"] == "done":
                raise ApiError(400, "งานนี้นายจ้างตรวจผ่านแล้ว")
            photo = save_photo(d.get("photo"), tid)
            con.execute("UPDATE tasks SET status='submitted', photo=?, comment=?, reject_note='', "
                        "submitted_by=?, submitted_at=? WHERE id=?",
                        (photo, str(d.get("comment", "")).strip()[:500], u["id"], now(), tid))
            task = self.get_task(con, tid)
        if t["photo"] and t["photo"] != photo:
            remove_photo(t["photo"])
        self.send_json(200, task)

    def api_review(self, u, tid, action):
        d = self.body()
        with db() as con:
            t = self.get_task(con, tid)
            if action == "approve":
                if t["status"] != "submitted":
                    raise ApiError(400, "งานนี้ยังไม่ได้ส่งหรือตรวจไปแล้ว")
                con.execute("UPDATE tasks SET status='done', approved_at=? WHERE id=?", (now(), tid))
            elif action == "reject":
                if t["status"] == "todo":
                    raise ApiError(400, "งานนี้ยังไม่ได้ส่ง")
                note = str(d.get("note", "")).strip()[:500] or "กรุณาทำใหม่"
                con.execute("UPDATE tasks SET status='todo', reject_note=?, approved_at=NULL WHERE id=?", (note, tid))
            elif action == "undo":
                if t["status"] != "done":
                    raise ApiError(400, "งานนี้ยังไม่ได้กด complete")
                con.execute("UPDATE tasks SET status='submitted', approved_at=NULL WHERE id=?", (tid,))
            task = self.get_task(con, tid)
        self.send_json(200, task)

    # --- งานที่เคยเพิ่ม ---
    def api_list_templates(self, u):
        with db() as con:
            rows = con.execute(TEMPLATE_SELECT + " ORDER BY tp.last_used_at DESC, tp.id DESC").fetchall()
        self.send_json(200, [dict(r) for r in rows])

    def api_delete_template(self, u, tid):
        with db() as con:
            con.execute("DELETE FROM task_templates WHERE id = ?", (tid,))
        self.send_json(200, {"ok": True})

    # --- ผู้ใช้ ---
    def api_list_users(self, u):
        with db() as con:
            rows = con.execute("SELECT id, username, name, role, created_at FROM users "
                               "ORDER BY role DESC, id").fetchall()
        self.send_json(200, [dict(r) for r in rows])

    def api_create_user(self, u):
        d = self.body()
        name = str(d.get("name", "")).strip()[:100]
        username = str(d.get("username", "")).strip()[:50]
        password = str(d.get("password", ""))
        role = d.get("role") if d.get("role") in ROLE_TH else "employee"
        if not name or not username:
            raise ApiError(400, "กรุณากรอกชื่อและชื่อผู้ใช้")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", username):
            raise ApiError(400, "ชื่อผู้ใช้ใช้ได้เฉพาะ a-z, 0-9, _ . -")
        if len(password) < 4:
            raise ApiError(400, "รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร")
        with db() as con:
            if con.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
                raise ApiError(400, "ชื่อผู้ใช้นี้มีอยู่แล้ว")
            cur = con.execute("INSERT INTO users (username, password, name, role, created_at) VALUES (?,?,?,?,?)",
                              (username, hash_password(password), name, role, now()))
        self.send_json(201, {"id": cur.lastrowid, "username": username, "name": name, "role": role})

    def api_delete_user(self, u, uid):
        if uid == u["id"]:
            raise ApiError(400, "ลบบัญชีตัวเองไม่ได้")
        with db() as con:
            if not con.execute("SELECT 1 FROM users WHERE id = ?", (uid,)).fetchone():
                raise ApiError(404, "ไม่พบผู้ใช้")
            con.execute("DELETE FROM users WHERE id = ?", (uid,))
        self.send_json(200, {"ok": True})


class Server(ThreadingHTTPServer):
    # Windows: ห้ามเปิดเซิร์ฟเวอร์ซ้อนพอร์ตเดียวกัน (ไม่งั้นคำขอจะสุ่มไปตัวใดตัวหนึ่ง)
    allow_reuse_address = os.name != "nt"
    daemon_threads = True

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


if __name__ == "__main__":
    import sys
    import threading
    import webbrowser

    init_db()
    try:
        server = Server((HOST, PORT), Handler)
    except OSError:
        print(f"[ERROR] พอร์ต {PORT} ถูกใช้งานอยู่ — อาจเปิดเซิร์ฟเวอร์ซ้อนไว้แล้ว")
        print(f"ลองเปิด http://localhost:{PORT} ดูก่อน หรือปิดหน้าต่างเซิร์ฟเวอร์เดิมแล้วรันใหม่")
        sys.exit(1)
    if "--open" in sys.argv:
        # เปิดเบราว์เซอร์หลังเซิร์ฟเวอร์พร้อมแล้ว
        threading.Timer(0.8, webbrowser.open, args=[f"http://localhost:{PORT}"]).start()
    print("=" * 50)
    print(" ระบบเช็คลิสต์งานพนักงาน กำลังทำงาน")
    print(f" เปิดบนเครื่องนี้:     http://localhost:{PORT}")
    ip = lan_ip()
    if ip:
        print(f" เปิดจากมือถือ (WiFi เดียวกัน): http://{ip}:{PORT}")
    print(" กด Ctrl+C เพื่อหยุด")
    print("=" * 50)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nหยุดระบบแล้ว")
