import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta


BET_KEY_RE = re.compile(r"\b(BET-\d+)\b")


def _days_ago(n):
    return (datetime.utcnow() - timedelta(days=n)).strftime("%Y-%m-%d")


def http_get(url, headers):
    cmd = ["curl", "-sS", "-w", "\n%{http_code}"]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    parts = r.stdout.rsplit("\n", 1)
    return (parts[0], parts[1]) if len(parts) == 2 else (r.stdout, "ERR")


def http_post(url, headers, body):
    cmd = ["curl", "-sS", "-w", "\n%{http_code}"]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd += ["-X", "POST", "-d", body]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    parts = r.stdout.rsplit("\n", 1)
    return (parts[0], parts[1]) if len(parts) == 2 else (r.stdout, "ERR")


def http_put(url, headers, body):
    cmd = ["curl", "-sS", "-w", "\n%{http_code}"]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd += ["-X", "PUT", "-d", body]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    parts = r.stdout.rsplit("\n", 1)
    return (parts[0], parts[1]) if len(parts) == 2 else (r.stdout, "ERR")


def main():
    multica_token = os.environ.get("MULTICA_TOKEN", "")
    if not multica_token:
        print("::notice::MULTICA_TOKEN not configured; skipping.")
        return 0

    workspace_id = os.environ.get("MULTICA_WORKSPACE_ID", "")
    api_base = os.environ.get("MULTICA_API_URL", "https://api.multica.ai")
    gh_token = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("REPO", "")

    mc_h = {
        "Authorization": f"Bearer {multica_token}",
        "X-Workspace-ID": workspace_id,
    }
    gh_h = {
        "Authorization": f"Bearer {gh_token}",
        "Accept": "application/vnd.github.v3+json",
    }
    json_h = {**mc_h, "Content-Type": "application/json"}

    # 1. Fetch open PRs and recently closed, unmerged PRs
    prs = []

    for label, query in [
        ("open", f"repo:{repo}+is:pr+is:open"),
        ("closed unmerged", f"repo:{repo}+is:pr+is:closed+is:not_merged+closed:>{_days_ago(30)}"),
    ]:
        print(f"Fetching {label} PRs...")
        body, code = http_get(
            f"https://api.github.com/search/issues?q={query}",
            gh_h,
        )
        if code != "200":
            print(f"::warning::Failed to fetch {label} PRs (HTTP {code})")
            continue
        batch = json.loads(body).get("items", [])
        for pr in batch:
            pr["_state"] = label
        prs.extend(batch)
        print(f"  {label}: {len(batch)} PRs")

    print(f"Found {len(prs)} total PRs to check")

    # 2. Extract unique BET-N keys from PR titles and branch names
    key_map = {}
    for pr in prs:
        title = pr.get("title", "")
        branch = pr.get("head_ref_name", "") or pr.get("headRefName", "")
        for key in BET_KEY_RE.findall(title + " " + branch):
            if key not in key_map:
                key_map[key] = []
            pr_num = pr.get("number")
            if not any(p["number"] == pr_num for p in key_map[key]):
                key_map[key].append(
                    {
                        "number": pr_num,
                        "title": title,
                        "url": pr.get("url", f"https://github.com/{repo}/pull/{pr_num}"),
                        "state": pr.get("_state", "open"),
                    }
                )

    print(f"Found {len(key_map)} unique issue keys")
    if not key_map:
        print("No BET-N keys in PRs. Nothing to reconcile.")
        return 0

    # 3. Check each issue status; revert violations
    violations = 0
    for key, pr_list in key_map.items():
        body, code = http_get(f"{api_base}/api/issues/{key}", mc_h)
        if code != "200":
            print(f"  {key}: HTTP {code}, skipping")
            continue
        try:
            issue = json.loads(body)
        except json.JSONDecodeError:
            print(f"  {key}: invalid JSON, skipping")
            continue

        status = issue.get("status", "")
        if status != "done":
            print(f"  {key}: status={status} (ok)")
            continue

        violations += 1
        open_count = sum(1 for p in pr_list if p.get("state", "open") == "open")
        closed_count = len(pr_list) - open_count
        pr_state_desc = []
        if open_count:
            pr_state_desc.append(f"{open_count} open")
        if closed_count:
            pr_state_desc.append(f"{closed_count} closed-unmerged")
        print(f"  {key}: VIOLATION (done, {', '.join(pr_state_desc)} PR)")

        pr_lines = "\n".join(
            f"  - PR #{p['number']}: {p['title']}"
            f" ({p['state']}) {p['url']}"
            for p in pr_list
        )
        pr_desc = "still open" if not closed_count else "open or closed without being merged"
        comment = (
            f"Guard: {key} was marked `done` while {len(pr_list)} linked PR(s) "
            f"are {pr_desc}.\n\n"
            f"Linked PRs:\n{pr_lines}\n\n"
            f"The issue cannot be marked `done` until all linked PRs are merged.\n"
            f"Status reverted to `in_review`."
        )

        _, cc = http_post(
            f"{api_base}/api/issues/{key}/comments",
            json_h,
            json.dumps({"content": comment}),
        )
        print(f"    comment: HTTP {cc}")

        _, sc = http_put(
            f"{api_base}/api/issues/{key}",
            json_h,
            json.dumps({"status": "in_review"}),
        )
        print(f"    revert:  HTTP {sc}")

    if violations:
        print(f"\nReverted {violations} violation(s).")
    else:
        print("\nNo violations found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
