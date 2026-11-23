# Agents — follow-ups

Open items deferred from the Agents phases. Each is decided (design + spec) when it is picked up.

## Changing autonomy from the chat (instead of Settings → Agents)

Today, when an action is set to Ask or Never, Manta tells the user to change it in Settings → Agents. Users would rather
do it from the conversation. Constraint: an agent must never raise its own autonomy (anything it reads could ask it to),
so the agent may only PROPOSE; the change needs the user's own click.

Direction discussed (2026-11-23), not decided:
- A tool lets Manta raise an app-drawn card in the chat ("Deploy is set to Never. Allow this once / Change to Ask /
  Change to Auto / Keep"); only the user's click applies it.
- "Allow this once" = that action, in that chat, for that turn; settings unchanged.
- Making a setting STRICTER could apply directly (it only restricts).
- Background tasks unchanged: they stop and report; Manta raises the card when it brings the result.
- Open decision: does "Allow this once" exist for Never too, or only for Ask (Never stays a hard wall, lifting it means
  changing the setting)?

### Refinement (user, 2026-11-23): an explicit request needs no card

- The card is only for a block the user didn't ask about: "build this and deploy" when deploy is Never/Ask (the user may
  not know the setting exists) — Manta offers the card.
- When the user explicitly asks to change a permission ("let agents deploy on their own for this project"), Manta applies
  it directly and confirms in one line (with undo) — asking again on a card makes no sense.
- Safety: Manta must not be able to do this because a file or web page asked. Idea: the change tool applies directly only
  when the request quotes the user's own latest message (the box knows which messages the user typed) and that message
  is about changing a permission; anything else falls back to the card.

## Per-project autonomy settings

Today one set of settings (mode + overrides) applies to every project. Wanted: e.g. agents may deploy plugin-builder on
their own but not ronda.
- Layers: box settings, then the project's overrides (last wins). A chat outside any project uses the box settings.
- Rules are already computed per task/chat at start, and projects have a stable identity (knowledge registry).
- Changed from the chat as above ("let agents deploy this project on their own"), with the same card/explicit split.

## From Phase 3c (docs/superpowers/specs/2026-11-23-agents-phase3c-judgement-and-action-map.md)

- Show the project's "Actions in this project" commands in Manta's own (lead) instructions, not only in tasks.
- Real isolation for tasks (a separate Unix user and OpenCode server per task).
- Specialists filing notes to the knowledge base themselves (today they have no `knowledge_note` grant).
- Host-based rules ("any command containing api.netlify.com").
- Test the approval card path with trust mode off.
