---
name: autocapture-status
description: Show the auto-capture status for mybrain — enabled/disabled state, current thresholds, token usage stats, and any warnings. Call brain_stats and format the auto-capture section as an aligned table.
---

# Auto-Capture Status

Show the current state of mybrain auto-capture.

## Steps

1. Call `mybrain:brain_stats` (the MCP tool) to get the raw stats output.

2. Also read the autocapture config file. The path is in the `AUTOCAPTURE_CONFIG` env var registered during setup (typically `~/.mybrain/<name>/.autocapture-config.json`). Use a Bash `cat` command to read it.

3. Format and display the status as an aligned table using `│` as the column delimiter. Example format:

```
Auto-capture  │ ENABLED
Model         │ llama-3.1-8b-instruct:free (via OpenRouter)
Scope default │ personal

Thresholds    │ 15 messages OR 20 min idle
              │ ↑ increase to process less frequently (no cost impact with free model)
              │ ↓ decrease to capture insights sooner

Today         │ 12 thoughts  │  8,412 tokens  │  $0.00
This week     │ 67 thoughts  │ 52,100 tokens  │  $0.00
This project  │ 142 thoughts │ projects.mybrain

Last session  │ 2026-04-23 14:32  │  3 thoughts captured
Warnings      │ none
```

4. If `brain_stats` shows truncation warnings, list them specifically:
```
Warnings      │ 1 truncation event on 2026-04-22 — some content from a large response
              │ may not have been analyzed. Consider breaking long responses into parts.
```

5. If auto-capture is DISABLED, add a note:
```
              │ Run /autocapture-on to re-enable background capture.
              │ Layer 1 (proactive in-session capture) is always active when mybrain
              │ MCP tools are connected.
```

6. If the config file is not found, tell the user: "Auto-capture has not been configured yet. Run /mybrain-setup to enable it."

## Cost Estimates

With the free `llama-3.1-8b-instruct:free` model (default), token usage costs $0.00 regardless of volume. If the user switched to a paid model, estimate cost as:
- `claude-haiku-4-5`: $0.80/M input + $4/M output tokens
- `gemini-flash-2.0-lite`: $0.075/M input + $0.30/M output
