#!/usr/bin/env python3
"""Print Morgan's data key, creating it on first use.

The key lives in the login keyring, which is itself encrypted with the login
password and unlocked at login. Nothing on disk can be read without it.

A key is made only when the keyring is open and certainly holds none. A
keyring that is locked, or not yet running (the service can start before it
at boot), is a failure to try again later: a new key put in its place would
leave everything already sealed unreadable, as happened on 21 October 2026.
"""
import base64
import os
import sys

import gi

gi.require_version("Secret", "1")
from gi.repository import GLib, Secret  # noqa: E402

# Still named heyclaude, as Morgan was: the key is found by these names, and
# renaming them risks not finding it (docs/rename.md, step 4).
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
        sys.exit("that is not a memory key")
    Secret.password_store_sync(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT, "heyclaude data key", given, None)
    sys.exit(0)


def stored():
    """The key in the keyring, or None when the open keyring has none."""
    try:
        service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS, None)
        default = Secret.Collection.for_alias_sync(service, Secret.COLLECTION_DEFAULT, Secret.CollectionFlags.NONE, None)
        # Locked ones too, so that a locked key is not taken for no key.
        items = service.search_sync(SCHEMA, ATTRIBUTES, Secret.SearchFlags.ALL | Secret.SearchFlags.UNLOCK | Secret.SearchFlags.LOAD_SECRETS, None)
    except GLib.Error as error:
        sys.exit(f"the login keyring is not available yet: {error.message}")
    for item in items:
        secret = None if item.get_locked() else item.get_secret()
        if secret is not None:
            return secret.get_text()
    if items or default is None or default.get_locked():
        sys.exit("the login keyring is locked")
    return None


key = stored()
if key is None:
    if "--no-create" in sys.argv:
        sys.exit(1)
    key = base64.b64encode(os.urandom(32)).decode()
    Secret.password_store_sync(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT, "heyclaude data key", key, None)
print(key)
