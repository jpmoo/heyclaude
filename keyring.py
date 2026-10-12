#!/usr/bin/env python3
"""Print heyclaude's data key, creating it on first use.

The key lives in the login keyring, which is itself encrypted with the login
password and unlocked at login. Nothing on disk can be read without it.
"""
import base64
import os
import sys

import gi

gi.require_version("Secret", "1")
from gi.repository import Secret  # noqa: E402

SCHEMA = Secret.Schema.new(
    "dev.heyclaude.Key",
    Secret.SchemaFlags.NONE,
    {"service": Secret.SchemaAttributeType.STRING, "kind": Secret.SchemaAttributeType.STRING},
)
ATTRIBUTES = {"service": "heyclaude", "kind": "data-key"}

if "--set" in sys.argv:
    # Put back a key that was written down: the one line read from standard input.
    given = sys.stdin.readline().strip()
    try:
        good = len(base64.b64decode(given, validate=True)) == 32
    except ValueError:
        good = False
    if not good:
        sys.exit("that is not a heyclaude key")
    Secret.password_store_sync(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT, "heyclaude data key", given, None)
    sys.exit(0)

key = Secret.password_lookup_sync(SCHEMA, ATTRIBUTES, None)
if key is None:
    if "--no-create" in sys.argv:
        sys.exit(1)
    key = base64.b64encode(os.urandom(32)).decode()
    Secret.password_store_sync(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT, "heyclaude data key", key, None)
print(key)
