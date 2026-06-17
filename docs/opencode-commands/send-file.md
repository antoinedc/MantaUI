---
description: Send a file from this remote box down to the user's laptop (their Downloads folder)
---

# /send-file

Deliver a file from this machine to the user's laptop. bui (the desktop app the
user is running) watches a special outbox directory on this box and pulls any
file that appears there down to the user's computer — the reverse of the user
dragging a file into the chat.

## How to send a file

Copy the file into `~/.bui-outbox/` on this box. That's it — bui detects it
within a few seconds and saves it to the user's Downloads folder (or, depending
on the user's settings, asks them to confirm first). The file is removed from
the outbox once it's been delivered.

```bash
mkdir -p ~/.bui-outbox
cp /path/to/the/file.pdf ~/.bui-outbox/
```

Keep the original filename meaningful — it becomes the name of the file the user
receives.

## Notes

- Only put files the user actually asked for (or that you generated for them)
  into the outbox. It writes straight to their machine.
- Don't copy huge files or whole directories — send the specific artifact.
- Scope by session if useful: `~/.bui-outbox/<anything>/file.ext` also works;
  the subdirectory is shown to the user as a label and otherwise ignored.
- This is delivery only. To *read* a file the user sent you, look in
  `~/.bui-uploads/` (or use the absolute path bui pasted into the prompt).

$ARGUMENTS
