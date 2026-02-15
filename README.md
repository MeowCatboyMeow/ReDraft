# ReDraft — SillyTavern Message Refinement Extension

Refines AI-generated messages by sending them (with configurable quality rules) to an LLM for improvement, then writes the refined version back into chat.

## Install

Paste this URL into SillyTavern's **Extensions > Install Extension** dialog:

```
https://github.com/YOUR_USERNAME/SillyTavern-ReDraft
```

Works immediately using your current ST connection. No extra setup needed.

## Optional: Separate Refinement LLM

Want to use a different model for refinement? Install the server plugin:

1. In ReDraft settings, click **Install Server Plugin**
2. Copy the command shown and run it in your SillyTavern root directory
3. Restart SillyTavern
4. Switch to "Use separate LLM" mode in ReDraft's Connection settings

## Features

- **Dual-mode**: Use ST's current API (zero config) or a separate LLM via server plugin
- **Four triggers**: `/redraft` slash command, per-message button, floating popout, auto-refine
- **Hybrid rules**: 6 toggleable presets + custom rules with drag-to-reorder
- **Undo**: One-click restore of original message
- **Native UI**: Matches SillyTavern's design — no custom colors, no emoji
