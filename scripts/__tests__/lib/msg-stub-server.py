#!/usr/bin/env python3
"""A stand-in for POST /api/messages, for the agent-msg.sh shell tests (C2 PR4).

agent-msg.sh used to send with curl, and these tests put a curl stub first on PATH. The send is python (urllib) now,
so the stub is a server instead: it listens on 127.0.0.1 on a free port, writes the port to <port-file>, appends each
request body (one JSON text per line) to <calls-file>, and answers 200 with the bytes of <reply-file> as they are at
that moment (a test rewrites it between sends; absent = {"id":4242}). Nothing leaves the machine.

Usage: python3 msg-stub-server.py <port-file> <calls-file> <reply-file>
"""
import http.server
import os
import sys

PORT_FILE, CALLS, REPLY = sys.argv[1:4]


class Stub(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(n).decode('utf-8', 'replace')
        with open(CALLS, 'a', encoding='utf-8') as f:
            f.write(body.replace('\n', ' ') + '\n')
        try:
            with open(REPLY, 'rb') as f:
                out = f.read()
        except OSError:
            out = b'{"id":4242}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(('127.0.0.1', 0), Stub)
tmp = PORT_FILE + '.tmp'
with open(tmp, 'w') as f:
    f.write(str(srv.server_address[1]))
os.replace(tmp, PORT_FILE)
srv.serve_forever()
