---
description: Open the live diagram viewer in your browser
allowed-tools: Bash(node:*)
---

Start the diagram viewer, which watches `.diagram/graph.json` and repaints
the browser whenever the diagram changes.

Run this, and report the URL it prints:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/diagram.mjs" serve
```

It stays running and serves on http://localhost:4400 (auto-incrementing if
that port is taken). It binds to 127.0.0.1 only.
