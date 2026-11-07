"""
ตัวเชื่อมสำหรับโฮสต์แบบ WSGI (เช่น PythonAnywhere)
ใช้โค้ดเดียวกับ server.py ทุกอย่าง แค่เปลี่ยนวิธีรับ/ส่งข้อมูล

บน PythonAnywhere ไฟล์ WSGI ของเว็บให้มีแค่:
    import sys
    sys.path.insert(0, "/home/<ชื่อผู้ใช้>/ptep-project")
    from wsgi import application
"""
import io
import os
from email.message import Message
from http import HTTPStatus

# ออนไลน์: ไม่สร้างบัญชีตัวอย่าง (admin/admin123) — คนแรกที่เปิดเว็บจะได้ตั้งบัญชีนายจ้างเอง
os.environ.setdefault("NO_DEMO_DATA", "1")

import server  # noqa: E402

server.init_db()


class WSGIHandler(server.Handler):
    """ใช้ Handler เดิม แต่เก็บผลลัพธ์ไว้ส่งกลับแบบ WSGI แทนการเขียนลง socket"""

    def __init__(self, environ):  # ไม่เรียก __init__ ของแม่ (ไม่มี socket)
        self.environ = environ
        path = environ.get("PATH_INFO", "/") or "/"
        qs = environ.get("QUERY_STRING")
        self.path = path + ("?" + qs if qs else "")
        self.command = environ.get("REQUEST_METHOD", "GET").upper()

        headers = Message()
        for key, value in environ.items():
            if key.startswith("HTTP_"):
                headers[key[5:].replace("_", "-").title()] = value
        if environ.get("CONTENT_LENGTH"):
            headers["Content-Length"] = environ["CONTENT_LENGTH"]
        if environ.get("CONTENT_TYPE"):
            headers["Content-Type"] = environ["CONTENT_TYPE"]
        if "X-Forwarded-Proto" not in headers and environ.get("wsgi.url_scheme"):
            headers["X-Forwarded-Proto"] = environ["wsgi.url_scheme"]
        self.headers = headers

        self.rfile = environ["wsgi.input"]
        self.wfile = io.BytesIO()
        self.status_line = "500 Internal Server Error"
        self.out_headers = []

    def send_response(self, code, message=None):
        try:
            phrase = message or HTTPStatus(code).phrase
        except ValueError:
            phrase = ""
        self.status_line = f"{code} {phrase}".strip()

    def send_header(self, key, value):
        self.out_headers.append((key, str(value)))

    def end_headers(self):
        pass

    def log_message(self, *args):
        pass


def application(environ, start_response):
    h = WSGIHandler(environ)
    h.dispatch(h.command)
    start_response(h.status_line, h.out_headers)
    return [h.wfile.getvalue()]
