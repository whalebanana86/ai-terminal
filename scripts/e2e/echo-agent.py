#!/usr/bin/env python3
# 터미널이 보낸 바이트를 그대로 보여 준다(한글 입력 확인용).
import os, sys, tty
tty.setraw(0)
os.write(1, b"ready\r\n")
while True:
    b = os.read(0, 1024)
    if not b or b == b"\x03":
        break
    os.write(1, (repr(b) + "  [" + b.decode("utf-8", "replace").replace("\r", "\\r") + "]\r\n").encode())
