#!/usr/bin/env python3
"""
Morgan as an ordinary application window.

The chat window in the bar is a panel: it cannot be tiled, kept on a
workspace, or left open beside other work. This is the same conversation in a
window that can. It is a web view around a page (index.html, beside this
file), as Talaria's windows are, and for the same reason it opens no port: the
page reaches the daemon through this program, over the daemon's own socket.

    window.py            open the window, or bring it forward if it is open
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys

from PySide6.QtCore import QEvent, QObject, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QDesktopServices, QIcon
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QFileDialog, QMainWindow

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
SOCKET = os.environ.get("HEYCLAUDE_SOCKET", os.path.join(RUNTIME, "heyclaude.sock"))
# The name a second launch finds the first by. A trial run, on a socket of its
# own, is its own window and leaves the real one alone.
ONE = "heyclaude-window-trial" if "HEYCLAUDE_SOCKET" in os.environ else "heyclaude-window"
NOCTALIA = os.path.expanduser("~/.local/bin/noctalia")
ICONS = os.path.expanduser("~/.local/share/noctalia/assets/fonts")  # the shell's own icon font


def accent() -> str:
    """The accent chosen for the plugin, so that the two look like one thing."""
    try:
        with open(os.path.expanduser("~/.local/state/noctalia/settings.toml"), encoding="utf-8") as settings:
            section = settings.read().split('[plugin_settings."jpmoo/morgan"]', 1)[1].split("\n[", 1)[0]
        if re.search(r'accent_source\s*=\s*"theme"', section):
            return ""
        return re.search(r'^accent\s*=\s*"(#[0-9a-fA-F]{6})', section, re.M).group(1)
    except (OSError, IndexError, AttributeError):
        return ""


class Bridge(QObject):
    """What the page may ask for, and how it hears what the daemon is doing."""

    event = Signal(str)   # one line of the daemon's event stream
    dropped = Signal(str)  # files dropped on the window, as a JSON list of paths

    def __init__(self, window: QMainWindow) -> None:
        super().__init__(window)
        self.window = window
        self.stream = QLocalSocket(self)
        self.buffer = b""
        self.stream.readyRead.connect(self._read)
        self.stream.connected.connect(lambda: self.stream.write(b"watch\n"))
        self.stream.disconnected.connect(lambda: QTimer.singleShot(2000, self._follow))
        self.stream.errorOccurred.connect(lambda _error: QTimer.singleShot(2000, self._follow))
        self._follow()

    def _follow(self) -> None:
        """Follow the daemon's events, and pick them up again after it restarts."""
        if self.stream.state() == QLocalSocket.LocalSocketState.UnconnectedState:
            self.buffer = b""
            self.stream.connectToServer(SOCKET)

    def _read(self) -> None:
        self.buffer += bytes(self.stream.readAll())
        *lines, self.buffer = self.buffer.split(b"\n")
        for line in lines:
            if line.strip():
                self.event.emit(line.decode("utf-8", "replace"))

    @Slot(str, result=str)
    def call(self, command: str) -> str:
        """One command to the daemon, and its answer. They are all quick."""
        try:
            with socket.socket(socket.AF_UNIX) as link:
                link.settimeout(20)
                link.connect(SOCKET)
                link.sendall(command.replace("\n", " ").encode() + b"\n")
                answer = b""
                while chunk := link.recv(65536):
                    answer += chunk
            return answer.decode("utf-8", "replace")
        except OSError as error:
            return json.dumps({"ok": False, "error": f"Morgan is not running ({error.strerror or error})"})

    @Slot(result=str)
    def look(self) -> str:
        """The plugin's accent, and its icons: the same font, and where each icon is in it."""
        glyphs = {}
        try:
            with open(os.path.join(ICONS, "tabler.json"), encoding="utf-8") as table:
                glyphs = {name: entry["codepoint"][2:] for name, entry in json.load(table).items()}
        except (OSError, ValueError, KeyError):
            pass
        return json.dumps({"accent": accent(), "font": os.path.join(ICONS, "noctalia-tabler.ttf"), "glyphs": glyphs})

    @Slot(result=str)
    def pick(self) -> str:
        """Files to attach, chosen in the desktop's own chooser."""
        paths, _ = QFileDialog.getOpenFileNames(self.window, "Attach to your message", os.path.expanduser("~"))
        return json.dumps(paths)

    @Slot()
    def settings(self) -> None:
        subprocess.Popen([NOCTALIA, "msg", "panel-open", "jpmoo/morgan:settings"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    @Slot(str)
    def title(self, text: str) -> None:
        self.window.setWindowTitle(text)


class Page(QWebEnginePage):
    """Links in an answer open in the browser, not in place of the conversation."""

    def acceptNavigationRequest(self, url: QUrl, kind, is_main_frame: bool) -> bool:  # noqa: N802 — Qt's name
        if url.scheme() in ("http", "https", "mailto"):
            QDesktopServices.openUrl(url)
            return False
        return True


class Window(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Morgan")
        self.resize(760, 860)
        self.view = QWebEngineView(self)
        self.view.setPage(Page(self.view))
        self.view.settings().setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        self.bridge = Bridge(self)
        self.channel = QWebChannel(self)
        self.channel.registerObject("bridge", self.bridge)
        self.view.page().setWebChannel(self.channel)
        self.setCentralWidget(self.view)
        self.view.load(QUrl.fromLocalFile(os.path.join(HERE, "index.html")))
        # A dropped file lands on the web view's inner widget, which would hand
        # the page a file with no path. It is caught there and the path passed on.
        self.view.loadFinished.connect(self._watch_drops)

    def _watch_drops(self, _ok: bool) -> None:
        target = self.view.focusProxy()
        if target is not None:
            target.setAcceptDrops(True)
            target.installEventFilter(self)

    def eventFilter(self, watched, event):  # noqa: ANN001, N802 — Qt's names
        if event.type() in (QEvent.Type.DragEnter, QEvent.Type.DragMove) and event.mimeData().hasUrls():
            event.acceptProposedAction()
            return True
        if event.type() == QEvent.Type.Drop and event.mimeData().hasUrls():
            paths = [url.toLocalFile() for url in event.mimeData().urls() if url.isLocalFile()]
            if paths:
                self.bridge.dropped.emit(json.dumps(paths))
            event.acceptProposedAction()
            return True
        return super().eventFilter(watched, event)


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Morgan")
    app.setDesktopFileName("dev.heyclaude.Morgan")
    app.setWindowIcon(QIcon(os.path.join(os.path.dirname(os.path.abspath(__file__)), "morgan.svg")))
    # One window. A second launch brings the first forward and goes away.
    first = QLocalSocket()
    first.connectToServer(ONE)
    if first.waitForConnected(300):
        first.write(b"raise\n")
        first.waitForBytesWritten(300)
        return 0
    QLocalServer.removeServer(ONE)
    server = QLocalServer()
    server.listen(ONE)
    window = Window()

    def forward() -> None:
        server.nextPendingConnection().close()
        window.showNormal()
        window.raise_()
        window.activateWindow()

    server.newConnection.connect(forward)
    window.show()
    # For checking the page without a person at it: a picture of the window
    # after a wait, and then away.
    shot = os.environ.get("HEYCLAUDE_WINDOW_SHOT")
    if shot:
        wait = int(os.environ.get("HEYCLAUDE_WINDOW_WAIT", "6000"))

        def record() -> None:
            window.grab().save(shot)
            # And what the page holds, as text, for when there is nothing to draw on.
            window.view.page().runJavaScript(
                "JSON.stringify({ title: document.title, name: document.getElementById('name').textContent,"
                " state: document.getElementById('state').textContent, messages: [...document.querySelectorAll('#log > *')]"
                ".map((node) => node.className + ' | ' + node.innerText.replace(/\\s+/g, ' ').slice(0, 110)),"
                " marks: document.querySelectorAll('.mark').length,"
                " folded: document.querySelectorAll('details.oracle:not([open])').length })",
                lambda found: (print(found), app.quit()))

        QTimer.singleShot(wait, record)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
