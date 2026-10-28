Revision round for your workstream spec (same worktree /home/dev/projects/better-ui-ios-parity; you may edit ONLY your own spec file).

1. Re-read docs/superpowers/specs/2026-10-28-ios-desktop-parity/00-master.md — it changed. Decisions D1–D19 and the updated C3/C4 are BINDING and override your spec where they disagree (notably D11 single NewSessionDraft, D12 producers, D13 composer adoption, D14 GitHub sign-in API, D15 command frame, D16 single owners of shared client members, D17 seat row, D18 integration/mount rules, D19 verify.sh).
2. Read your review: reviews/round1/<ID>.md, and the cross-cutting review reviews/round1/00-cross-cutting.md (apply every finding that mentions your workstream).
3. Revise your spec to resolve EVERY BLOCKING and SHOULD finding (and NITs where cheap). Verify each fix against the code. If you believe a finding is wrong, keep your position only with code evidence, recorded in the new section below.
4. Replace your "Mount requests" section with a table per D18: ID (M-<ws>-<n>), receiving file, applier (per D18), provider symbol(s), exact change, prerequisite. Also list mounts you RECEIVE (applied by you) per D18 in a "Mounts applied by this workstream" table, cross-checking other specs' tables in the same folder.
5. List, under "Client members", every new MantaAPIClient method you add (name + signature) — no duplicates of members another spec owns (D16).
6. Append a section "## Review responses (round 1)" mapping each finding number → what changed (or the evidence-based rebuttal).
Reply with only: path, findings resolved count, rebuttals (one line each), any new cross-spec dependency you introduced.
