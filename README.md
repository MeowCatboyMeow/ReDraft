# ReDraft — SillyTavern Message Refinement Extension

Refines AI-generated messages by sending them (with configurable quality rules) to an LLM for improvement, then writes the refined version back into chat.

## Install

Paste this URL into SillyTavern's **Extensions > Install Extension** dialog:

```
https://github.com/Avolix/ReDraft
```

Works immediately using your current ST connection. No extra setup needed.

## Features

- **Zero config**: Uses your existing SillyTavern API connection — nothing extra to install
- **Four triggers**: `/redraft` slash command, per-message button, floating popout, auto-refine
- **8 built-in rules**: Grammar, echo removal, repetition, character voice, prose cleanup, formatting, crafted endings, lore consistency
- **Custom rules**: Add your own refinement rules with drag-to-reorder and import/export
- **Undo**: One-click restore of original message
- **Diff view**: Visual word-level diff with changelog showing which rules triggered each change
- **Point of view**: Auto-detect or manually set PoV to prevent perspective shifts
- **Native UI**: Matches SillyTavern's design — no custom colors, no emoji
