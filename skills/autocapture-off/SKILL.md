---
name: autocapture-off
description: Disable mybrain background auto-capture (Layer 2). Sets enabled=false in the autocapture config file. The Stop hook still fires but exits immediately. Does NOT affect Layer 1 (proactive in-session capture via CLAUDE.md instruction).
---

# Disable Auto-Capture

## Steps

1. Find the autocapture config file. Check `AUTOCAPTURE_CONFIG` env var first, then try `~/.mybrain/*/autocapture-config.json`.

2. If no config file is found: tell the user "Auto-capture is not configured — nothing to disable."

3. If found: read the config, set `"enabled": false`, write it back. Preserve all other settings.

4. Confirm to the user:
   ```
   Background auto-capture DISABLED

   The Stop hook remains registered but exits immediately (no processing, no cost).
   Layer 1 (proactive in-session capture) is still active — Claude will continue
   to call capture_thought when it identifies something important during sessions.

   To disable Layer 1 as well, remove the mybrain instruction from ~/.claude/CLAUDE.md.
   To re-enable background capture: /autocapture-on
   ```

## Notes

- This only affects Layer 2 (background batch analysis). It does NOT prevent Claude from proactively calling `capture_thought` during sessions when the CLAUDE.md instruction is present.
- To fully disable all auto-capture, also remove the mybrain instruction block from `~/.claude/CLAUDE.md`.
- Manual `capture_thought` calls are unaffected by either layer's state.
