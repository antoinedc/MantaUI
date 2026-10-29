// cloneView.mjs — the words of the GitHub clone flow, owned by the box (WS11 D5 / audit S8).
// Both clients render what `forge:clone-status` / `forge:repos` return; raw git stderr is classified here
// and never shown.
//
// Pure.

/**
 * Classify a failed `git clone`'s stderr. Order matters: a destination problem is never attributed to
 * the GitHub token, and GitHub's "could not read Username" / "Repository not found" reads like a generic
 * error but is really a permission (token scope) problem.
 * @returns {"permission" | "disk" | "network" | "destination" | "unknown"}
 */
export function cloneErrorKind(stderr) {
  const s = String(stderr ?? "").toLowerCase();
  if (/could not create leading directories|destination path .* already exists|not an empty directory/.test(s)) {
    return "destination";
  }
  if (
    /permission to .* denied|permission denied|could not read (username|password)|authentication failed|not authorized|repository not found|\b403\b|check that you have the correct access rights/.test(s)
  ) {
    return "permission";
  }
  if (/no space left on device|disk (is )?full|insufficient|write error: no space|enospc/.test(s)) {
    return "disk";
  }
  if (
    /could not resolve host|connection (timed out|refused|reset)|network is unreachable|failed to connect|unable to access|temporary failure in name resolution|ssl|tls/.test(s)
  ) {
    return "network";
  }
  return "unknown";
}

/** What a failed clone says, as a clause after the repo's name ("<name> — <message>"). */
export function cloneFailureMessage(kind) {
  switch (kind) {
    case "permission":
      return "permission denied. The token may not have access to this repository.";
    case "disk":
      return "not enough disk space in the clone location.";
    case "network":
      return "a network error prevented the clone.";
    case "destination":
      return "the clone destination is not usable.";
    default:
      return "the clone failed.";
  }
}

/** A clone-status snapshot; a failed one (done, not ok, not cancelled) gains `errorKind` and `message`. */
export function decorateCloneStatus(status) {
  if (!status || typeof status !== "object") return status;
  if (!status.done || status.ok || status.cancelled) return status;
  const errorKind = cloneErrorKind(status.error ?? "");
  return { ...status, errorKind, message: cloneFailureMessage(errorKind) };
}

/** The box returns machine codes for a failed repo listing; no client renders one verbatim. */
export function repoListErrorMessage(code) {
  if (code === "not_connected" || code === "rejected") return "GitHub isn't connected. Go back and sign in again.";
  if (code === "rate_limited") return "GitHub's rate limit is used up. Try again in a few minutes.";
  if (code === "forbidden") {
    return "GitHub refused this request. If the repositories belong to an organisation, it may require SSO authorisation for your sign-in.";
  }
  if (code === "network") return "Couldn't reach GitHub from your server. Check its connection and try again.";
  return "Couldn't list your repositories from GitHub.";
}

/** The repo list result; an error gains `message` and `needsSignIn` (the credential is missing or dead). */
export function decorateRepoList(result) {
  if (!result || !result.error) return result;
  return {
    ...result,
    message: repoListErrorMessage(result.error),
    needsSignIn: result.error === "not_connected" || result.error === "rejected",
  };
}
