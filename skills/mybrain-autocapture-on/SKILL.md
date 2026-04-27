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

5. Check `~/.claude/CLAUDE.md` for the mybrain proactive instruction block (marker: `<!-- mybrain:capture_thought proactively -->`). If absent, append it:

   ```markdown
   <!-- mybrain:capture_thought proactively -->
   ## MyBrain — Proactive Knowledge Capture

   When mybrain MCP tools are available, proactively call capture_thought when you identify:
   - Decisions (architectural, product, life): thought_type="decision", importance=0.7-0.9
   - Rejected alternatives with reasoning: thought_type="rejection", importance=0.5-0.7
   - Explicit preferences (tools, workflows, style): thought_type="preference", importance=0.8-1.0
   - Non-obvious lessons or patterns discovered: thought_type="lesson", importance=0.6-0.8
   - Important mid-task discoveries: thought_type="insight", importance=0.5-0.7
   - Personal facts worth long-term remembering (subscriptions, reference info, key dates): thought_type="fact", importance=0.9-1.0
   - Personal reflections (goals, values, life decisions): thought_type="reflection", importance=0.7-0.9

   Capture at the moment of realization. Do not duplicate what you've already captured this session.
   For project work: scope is auto-detected. For personal/non-project thoughts, no special action needed.
   <!-- end mybrain:capture_thought proactively -->
   ```

6. Confirm to the user:
   ```
   Auto-capture ENABLED (both layers)

   Layer 2 (background): Stop hook active — batch processing after <batch_threshold_messages> messages or <batch_threshold_minutes> min idle.
   Layer 1 (proactive):  mybrain instruction present in ~/.claude/CLAUDE.md.

   Run /mybrain-autocapture-status to monitor.
   ```

## Notes

- Enabling takes effect on the next Claude Code response.
- Manual `capture_thought` calls are never affected by this setting.
