---
name: autocapture-on
description: Enable mybrain auto-capture. Sets enabled=true in the autocapture config file and verifies the Stop hook is registered in ~/.claude/settings.json. Does not affect Layer 1 (proactive in-session capture via CLAUDE.md instruction), which is always active.
---

# Enable Auto-Capture

## Steps

1. Find the autocapture config file. Check `AUTOCAPTURE_CONFIG` env var first, then try `~/.mybrain/*/autocapture-config.json` (glob for any brain instance).

2. If no config file is found: tell the user "Auto-capture has not been configured yet. Run /mybrain-setup to set it up."

3. If found: read the config, set `"enabled": true`, write it back. Preserve all other settings (model, thresholds, etc.).

4. Verify the Stop hook is still registered in `~/.claude/settings.json`:
   ```bash
   cat ~/.claude/settings.json
   ```
   Look for a Stop hook pointing to `stop-autocapture.mjs`. If missing, re-add it:
   ```json
   "hooks": {
     "Stop": [{"hooks": [{"type": "command", "command": "node /path/to/hooks/stop-autocapture.mjs", "timeout": 30}]}]
   }
   ```
   Merge carefully — preserve any existing hooks.

5. Confirm to the user:
   ```
   Auto-capture ENABLED

   Background sweep will process sessions every <sweep_interval_minutes> minutes.
   Layer 1 (proactive in-session capture) is always active.
   Run /autocapture-status to monitor.
   ```

## Notes

- Enabling auto-capture does NOT restart any running sessions — it takes effect on the next Claude Code response.
- Layer 1 (CLAUDE.md proactive instruction) is independent of this setting and always active when mybrain MCP tools are connected.
