# Contributing

Morgan (this repository, `heyclaude`) is licensed under the **GNU General
Public License, version 3 only** (`LICENSE`). Its owner also licenses it on
other terms, including commercial ones — the same arrangement as Talaris, the
desktop shell Morgan is built into, so the two products are offered the same
way.

**Before a contribution can be accepted, its author has to agree to the
Contributor License Agreement in `CLA.md`.** You keep the copyright in what you
write; the agreement gives the owner the license needed to keep offering
Morgan under both the GPL and other terms. Without it, every outside
contribution would need its author's separate permission before Morgan could be
licensed any other way.

Say in your pull request that you have read `CLA.md` and agree to it.

## Source files

Every new source file starts with:

```
SPDX-License-Identifier: GPL-3.0-only
Copyright (c) <year> Jeff Moore
```

in whatever comment syntax the file uses (`//` in JavaScript, `--` in Luau, `#`
in Python, shell and systemd units, `<!-- -->` in HTML). It goes after a `#!`
line where there is one. Files written before the license was added do not
carry the header yet; they are covered by `LICENSE` all the same.

Vendored files keep their own license and header: `window/markdown-it.min.js`
is markdown-it's, under the MIT license.

**"Only," not "or later."** "Or later" would let a future version of the GPL,
written by someone else, apply to Morgan without the owner choosing it.

