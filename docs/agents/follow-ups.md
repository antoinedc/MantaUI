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

## Settings changes should apply to open chats right away

Today a change to the autonomy settings only reaches NEW chats: the lead's instructions are built when a chat starts.
Wanted: the change applies to the current chats too (background tasks keep the rules they started with). Needs a way to
refresh a running chat's instructions without breaking its prompt cache more than necessary (e.g. a short "your
settings changed: …" note on the next turn instead of rebuilding the whole brief).

Seen live (2026-11-23, plugin-builder chat): after the settings were switched to Autonomous and OpenCode restarted, the
chat HAD the new rules but still refused to deploy, staying consistent with its own earlier "deploys are turned off"
replies, until the user insisted. Planned fix: on a settings change, each open led chat gets a one-time note on its next
turn ("your autonomy settings changed at HH:MM: deploy is now Tell me; what you said earlier about these limits is out
of date"), appended rather than rebuilding the brief (cheap for the prompt cache). Test: refuse → change setting → ask
again in the same chat → it acts.

## The result's action matcher doesn't understand quotes

Seen live: a Dev task that only edited code and ran tests was reported as "Done without asking: deploy — fly deploy".
The command matcher splits on `;`, `&&`, `|`, newlines without respecting quotes, so text inside a quoted string (e.g. a
test fixture) can read as a command. Fix: quote-aware splitting (a small shell tokenizer, e.g. shell-quote), and only
count a segment that actually starts a command.

## From Phase 3c (docs/superpowers/specs/2026-11-23-agents-phase3c-judgement-and-action-map.md)

- Show the project's "Actions in this project" commands in Manta's own (lead) instructions, not only in tasks.
- Real isolation for tasks (a separate Unix user and OpenCode server per task).
- Specialists filing notes to the knowledge base themselves (today they have no `knowledge_note` grant).
- Host-based rules ("any command containing api.netlify.com").
- Test the approval card path with trust mode off.
