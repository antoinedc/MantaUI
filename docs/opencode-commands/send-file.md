---
description: Send a file from this remote box down to the user's machine as a durable artifact
---

# /send-file

Deliver a file from this machine to the user's machine. manta keeps a durable,
workspace-linked mailbox on this box (`~/.manta-outbox/<sessionID>/`) and
announces anything that appears there as an "AI sent you a file" toast; the
file also shows up in the app's Artifacts panel Files tab for this conversation.

## Preferred: the `send_file` tool

Use the `send_file` opencode tool (installed at
`~/.config/opencode/tools/send-file.ts`) — it knows this session's id, so the
file is automatically workspace-linked. It copies the file (your working copy
is kept), sets a TTL (default 7 days), and records it in the Files tab.

## Fallback: bare copy (rarely)

Only if the tool is not installed. Copy the file into a subdir named by this
session's id:

```bash
mkdir -p ~/.manta-outbox/<session_id>
cp /path/to/the/file.pdf ~/.manta-outbox/<session_id>/
```

Keep the original filename meaningful — it becomes the name the user receives.

## Semantics

- **Durable, not one-shot.** The file is NOT deleted when the user downloads
  it; it stays retrievable until it expires (TTL, default 7 days), then the
  box's sweep removes it.
- **Workspace-linked.** Files under a `<sessionID>/` subdir show only in that
  conversation's Artifacts Files tab. A bare copy to the mailbox root is NOT
  workspace-linked and won't appear per-conversation.
- Only send files the user actually asked for (or that you generated for them) —
  it writes straight to their machine.
- Don't copy huge files or whole directories — send the specific artifact.
- This is delivery only. To *read* a file the user sent you, look in
  `~/.manta-uploads/` (or use the absolute path manta pasted into the prompt).
