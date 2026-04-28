---
name: mybrain-autocapture-on
description: Enable mybrain auto-capture — both Layer 2 (background batch analysis via Stop hook) and Layer 1 (proactive in-session capture via CLAUDE.md instruction).
---

# Enable Auto-Capture

Enables both capture layers:
- **Layer 2**: sets `enabled=true` in the config and verifies the Stop hook is registered
- **Layer 1**: restores the mybrain proactive instruction block in `~/.claude/CLAUDE.md` if absent

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

5. Verify the sweep crontab entry is present:
   ```bash
   crontab -l 2>/dev/null | grep "stop-autocapture\|sweep.mjs"
   ```
   If missing, re-add it (replace values from the config):
   ```bash
   (crontab -l 2>/dev/null; echo "*/<sweep_interval_minutes> * * * * AUTOCAPTURE_CONFIG=$HOME/.mybrain/<name>/.autocapture-config.json node <plugin-root>/hooks/sweep.mjs >> $HOME/.mybrain/<name>/sweep.log 2>&1") | crontab -
   ```

6. Check `~/.claude/CLAUDE.md` for the mybrain proactive instruction block (marker: `<!-- mybrain:capture_thought proactively -->`). If absent, read the canonical block from `<plugin-root>/templates/proactive-instruction.md` and append its full contents to `~/.claude/CLAUDE.md`.

7. Confirm to the user:
   ```
   Auto-capture ENABLED (both layers)

   Layer 2 (background): Stop hook active — batch processing after <batch_threshold_messages> messages or <batch_threshold_minutes> min idle.
   Layer 1 (proactive):  mybrain instruction present in ~/.claude/CLAUDE.md.

   Run /mybrain-autocapture-status to monitor.
   ```

## Notes

- Enabling takes effect on the next Claude Code response.
- Manual `capture_thought` calls are never affected by this setting.
