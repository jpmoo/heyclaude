#!/usr/bin/env python3
"""
Where the time goes in a turn: each question is put to a trial daemon in one
running conversation, and the moments its events arrive are noted.

    HEYCLAUDE_SOCKET=... python3 tests/steps.py "question" "question" ...
"""
import json
import os
import socket
import sys
import time


def send(command):
    link = socket.socket(socket.AF_UNIX)
    link.connect(os.environ["HEYCLAUDE_SOCKET"])
    link.sendall((command + "\n").encode())
    return link


print(f"{'sorted':>7} {'oracle':>7} {'first':>7} {'done':>7}   (seconds; oracle = its answer in hand, first = first words shown)")
for question in sys.argv[1:]:
    watch = send("watch")
    lines = watch.makefile()
    lines.readline()
    began = time.time()
    send("type " + question).recv(200)
    at = {}
    for line in lines:
        event = json.loads(line)
        now = time.time() - began
        kind = event["type"]
        if kind == "kind": at.setdefault("sorted", now)
        if kind == "oracle": at["oracle"] = now
        if kind in ("partial", "sentence", "assistant"): at.setdefault("first", now)
        if kind == "state" and event["state"] == "idle":
            at["done"] = now
            break
    watch.close()
    cell = lambda key: f"{at[key]:7.1f}" if key in at else "      -"
    print(f"{cell('sorted')} {cell('oracle')} {cell('first')} {cell('done')}   {question}")
    time.sleep(1.5)
