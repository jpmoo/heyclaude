#!/usr/bin/env python3
"""
How well questions are routed and answered: each one in questions.json is put
to a daemon, and what comes back is checked for whether the Oracle was asked
when it should have been (and not when it should not), and whether the answer
holds one of the things it ought to.

Run it against a trial daemon, never the one in use:

    HEYMORGAN_SOCKET=... python3 tests/routing.py [label]
"""
import json
import os
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
kinds = []


def send(command):
    link = socket.socket(socket.AF_UNIX)
    link.connect(os.environ["HEYMORGAN_SOCKET"])
    link.sendall((command + "\n").encode())
    return link


def ask(question):
    watch = send("watch")
    lines = watch.makefile()
    lines.readline()
    began = time.time()
    send("type " + question).recv(200)
    used, answer = set(), ""
    kinds.clear()
    for line in lines:
        event = json.loads(line)
        if os.environ.get("EVENTS") and event["type"] not in ("partial", "levels"):
            print("   ", json.dumps(event)[:260])
        if event["type"] == "kind":
            kinds.append(event["kind"])
        if event["type"] == "consult":
            used.add("quick" if event.get("quick") else "full")
        if event["type"] == "assistant":
            answer = event["text"]
        if event["type"] == "state" and event["state"] == "idle":
            break
    watch.close()
    if not os.environ.get("RUNNING"):
        send("new").recv(200)  # each question on its own
    time.sleep(float(os.environ.get("PAUSE", 1.5)))
    return used, answer, time.time() - began


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else "run"
    questions = json.load(open(os.path.join(HERE, os.environ.get("QUESTIONS", "questions.json")), encoding="utf-8"))
    routed = answered = checked = 0
    slow = []
    for entry in questions:
        used, answer, took = ask(entry["q"])
        route = "oracle" if used else "self"
        right_route = route == entry["route"]
        low = answer.lower()
        right_answer = not entry["want"] or any(want.lower() in low for want in entry["want"])
        routed += right_route
        if entry["want"]:
            checked += 1
            answered += right_answer
        slow.append(took)
        flag = ("  " if right_route else "R ") + ("  " if right_answer else "A ")
        via = "+".join(sorted(used)) or "self"
        via += "/" + str(kinds[0] if kinds else "-")
        print(f"{flag}{took:5.1f}s {via:18} {entry['q'][:62]:62} | {answer[:70]!r}")
    total = len(questions)
    print(f"\n{label}: routed as intended {routed}/{total}; answers holding what they should {answered}/{checked}; "
          f"median {sorted(slow)[len(slow) // 2]:.1f}s, slowest {max(slow):.1f}s")


if __name__ == "__main__":
    main()
