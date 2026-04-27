---
name: mybrain-autocapture-off
description: Disable mybrain auto-capture completely — both Layer 2 (background batch analysis) and Layer 1 (proactive in-session capture). Sets enabled=false in the config and removes the mybrain instruction block from ~/.claude/CLAUDE.md.
---

# Disable Auto-Capture

Disables both capture layers:
- **Layer 2**: sets `enabled=false` in the config — the Stop hook fires but exits immediately
- **Layer 1**: removes the mybrain proactive instruction block from `~/.claude/CLAUDE.md`

## Steps

1. Find the autocapture config file. Check `AUTOCAPTURE_CONFIG` env var first, then try `~/.mybrain/*/autocapture-config.json`.

2. If no config file is found: tell the user "Auto-capture is not configured — nothing to disable."

3. If found: read the config, set `"enabled": false`, write it back. Preserve all other settings.

4. Remove the mybrain proactive instruction block from `~/.claude/CLAUDE.md`:
   - Look for the block delimited by `<!-- mybrain:capture_thought proactively -->` and `<!-- end mybrain:capture_thought proactively -->`
   - If found: remove the entire block (including the comment markers)
   - If not found: note it was already absent

5. Confirm to the user:
   ```
   Auto-capture DISABLED (both layers)

   Layer 2 (background): Stop hook exits immediately — no batch processing.
   Layer 1 (proactive):  mybrain instruction removed from ~/.claude/CLAUDE.md.

   Manual capture_thought calls are unaffected.
   To re-enable: /mybrain-autocapture-on
   ```

## Notes

- Manual `capture_thought` calls are never affected by this setting.
- Re-enabling with `/mybrain-autocapture-on` restores both layers.
