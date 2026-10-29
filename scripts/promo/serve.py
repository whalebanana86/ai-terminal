#!/usr/bin/env python3
"""빌드한 화면(dist/)을 헤드리스 크롬이 장면 그림을 그릴 때 읽도록 띄운다. 스타일·글꼴을 crossorigin 으로 불러서 CORS 머리를 붙인다.
사용: serve.py <폴더> <포트>"""
import functools
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), functools.partial(Handler, directory=sys.argv[1])).serve_forever()
