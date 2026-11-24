#!/usr/bin/env python3
"""Prints who is working on this machine, as JSON: projects, the Codex and
Claude Code sessions open in each, and the workers each session launched.

Reads only the tails of session logs touched recently:
~/.codex/sessions/**/rollout-*.jsonl and ~/.claude/projects/*/*.jsonl, with
each Claude Code session's subagents beside it. The session named by
CLAUDE_CODE_SESSION_ID (the one drawing the tree) is marked `isOwn`.

  sessions.py                  the JSON
  sessions.py --watch          the tree, redrawn every two seconds
  sessions.py --project voice  only projects whose name contains "voice"
"""
import glob
import json
import os
import re
import sys
import time
from datetime import datetime

RECENT_S = 3600  # a session quiet for longer is not listed as open
LIVE_S = 180  # a turn with no write for longer is shown as waiting
WORKER_S = 120  # a worker quiet for longer is not listed
TAIL = 262144
HOME = os.path.expanduser("~")


def ms(stamp):
    try:
        return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def tail(path, size=TAIL):
    total = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, total - size))
        lines = f.read().decode("utf-8", "replace").splitlines()
    if total > size:
        lines = lines[1:]
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def one_line(text, limit=90):
    for line in str(text).splitlines():
        line = line.strip()
        if line:
            return line[:limit]
    return ""


def describe(tool, args):
    args = args if isinstance(args, dict) else {}
    path = args.get("file_path")
    base = os.path.basename(path) if isinstance(path, str) else ""
    if tool == "WebFetch" and args.get("url"):
        return "Fetching " + re.sub(r"^https?://([^/]+).*$", r"\1", str(args["url"]))
    if tool == "WebSearch" and args.get("query"):
        return 'Searching "%s"' % args["query"]
    if tool == "Bash":
        return one_line(args.get("description") or args.get("command") or "Running a command")
    if tool == "Read" and base:
        return "Reading " + base
    if tool in ("Edit", "Write") and base:
        return "Editing " + base
    if tool in ("Agent", "Task") and args.get("description"):
        return "Starting worker: " + one_line(args["description"])
    return tool


def project_root(cwd):
    """The project a directory belongs to: its git repository's top folder
    (a worktree's main repository), else the directory itself."""
    start = cwd.rstrip("/") or "/"
    cur = start
    while True:
        mark = os.path.join(cur, ".git")
        if os.path.isdir(mark):
            return cur
        if os.path.isfile(mark):
            try:
                with open(mark) as f:
                    match = re.match(r"gitdir:\s*(.+?)/\.git/worktrees/", f.read().strip())
                if match:
                    return match.group(1)
            except OSError:
                pass
            return cur
        parent = os.path.dirname(cur)
        if parent == cur or cur == HOME:
            return start
        cur = parent


def recent(pattern, now, within):
    found = []
    for path in glob.glob(pattern, recursive=True):
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if now - mtime <= within:
            found.append((mtime, path))
    return found


def read_claude(path):
    """One Claude Code log's tail: where it works, on what, and what it does."""
    cwd = model = action = ""
    started = None
    is_working = False
    for entry in tail(path):
        kind = entry.get("type")
        message = entry.get("message") or {}
        content = message.get("content") if isinstance(message, dict) else None
        cwd = entry.get("cwd") or cwd
        if kind == "user":
            blocks = content if isinstance(content, list) else []
            is_prompt = isinstance(content, str) or any(
                isinstance(b, dict) and b.get("type") == "text" for b in blocks)
            if is_prompt and not entry.get("isMeta"):
                started = ms(entry.get("timestamp", "")) or started
                action = "Thinking"
            is_working = True
        elif kind == "assistant":
            model = message.get("model") or model
            is_working = message.get("stop_reason") != "end_turn"
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    action = describe(block.get("name", ""), block.get("input"))
                elif block.get("type") == "text" and block.get("text"):
                    action = one_line(block["text"])
    return cwd, re.sub(r"^claude-", "", model), action, started, is_working


def claude_workers(session_path, now):
    """The subagents a Claude Code session launched, from the folder beside its log."""
    workers = []
    folder = os.path.join(session_path[:-6], "subagents")
    for mtime, path in recent(os.path.join(folder, "agent-*.jsonl"), now, WORKER_S):
        meta = {}
        try:
            with open(path[:-6] + ".meta.json") as f:
                meta = json.load(f)
        except Exception:
            pass
        _, model, action, started, is_working = read_claude(path)
        done = bool(meta.get("finished")) or not is_working
        workers.append({
            "id": os.path.basename(path),
            "name": meta.get("description") or meta.get("agentType") or "subagent",
            "model": model or re.sub(r"^claude-", "", str(meta.get("model") or "")),
            "state": "done" if done else "running",
            "startTime": started or int(mtime * 1000),
            "action": "Done" if done else action,
        })
    return workers


def claude(now, own):
    sessions = []
    for mtime, path in recent(os.path.join(HOME, ".claude/projects/*/*.jsonl"), now, RECENT_S):
        session = os.path.basename(path)[:-6]
        cwd, model, action, started, is_working = read_claude(path)
        if not model:
            continue
        workers = claude_workers(path, now)
        # A session waiting on its workers is working too.
        live = (is_working and now - mtime <= LIVE_S) or any(w["state"] == "running" for w in workers)
        sessions.append({
            "id": "claude:" + session,
            "kind": "Claude Code",
            "cwd": cwd,
            "model": model,
            "state": "running" if live else "waiting",
            "startTime": started if (live and started) else int(mtime * 1000),
            "action": action if live else "Finished its turn",
            "isOwn": session == own,
            "workers": workers,
            "mtime": mtime,
        })
    return sessions


def codex(now):
    """Codex sessions, each with the id of the thread that spawned it, if any."""
    sessions = []
    for mtime, path in recent(os.path.join(HOME, ".codex/sessions/**/rollout-*.jsonl"), now, RECENT_S):
        cwd = model = action = ""
        started = None
        is_working = False
        for entry in tail(path):
            kind = entry.get("type")
            body = entry.get("payload") or {}
            if not isinstance(body, dict):
                continue
            sub = body.get("type")
            if kind == "turn_context":
                cwd = body.get("cwd") or cwd
                model = body.get("model") or model
            elif sub == "task_started":
                is_working = True
                started = ms(entry.get("timestamp", "")) or started
                action = "Thinking"
            elif sub == "task_complete":
                is_working = False
            elif sub == "item_completed":
                item = body.get("item") or {}
                if item.get("type") == "CommandExecution":
                    command = item.get("command") or []
                    action = "Ran " + one_line(command[-1] if command else "a command", 80)
                elif item.get("type") == "AgentMessage":
                    texts = [c.get("text", "") for c in item.get("content") or [] if isinstance(c, dict)]
                    action = one_line(" ".join(texts)) or action
            elif sub == "function_call":
                action = "Calling " + str(body.get("name"))
        # The first line says who started it; it can be long, so only its head is read.
        parent = nickname = source = ""
        try:
            with open(path, "rb") as f:
                head = f.read(65536).decode("utf-8", "replace")
            match = re.search(r'"parent_thread_id":"([^"]+)"', head)
            parent = match.group(1) if match else ""
            match = re.search(r'"agent_nickname":"([^"]+)"', head)
            nickname = match.group(1) if match else ""
            match = re.search(r'"agent_path":"([^"]+)"', head)
            task = match.group(1).split("/")[-1].replace("_", " ") if match else ""
            match = re.search(r'"originator":"([^"]+)"', head)
            source = match.group(1) if match else ""
            if not cwd:
                match = re.search(r'"cwd":"([^"]+)"', head)
                cwd = match.group(1) if match else ""
        except OSError:
            task = ""
        live = is_working and now - mtime <= LIVE_S
        thread = re.sub(r"^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-", "", os.path.basename(path)[:-6])
        sessions.append({
            "id": "codex:" + thread,
            "thread": thread,
            "parent": parent,
            "isExec": source == "codex_exec",
            "name": " ".join(x for x in (nickname, task) if x),
            "kind": "Codex",
            "cwd": cwd,
            "model": model,
            "state": "running" if live else "waiting",
            "startTime": started if (live and started) else int(mtime * 1000),
            "action": action if live else "Finished its turn",
            "isOwn": False,
            "workers": [],
            "mtime": mtime,
        })
    return sessions


def as_worker(session, label):
    quiet = session["state"] != "running"
    return {
        "id": session["id"],
        "name": session.get("name") or label,
        "model": session["model"],
        "state": "done" if quiet else "running",
        "startTime": session["startTime"],
        "action": "Done" if quiet else session["action"],
    }


def scan():
    now = time.time()
    claudes = claude(now, os.environ.get("CLAUDE_CODE_SESSION_ID", ""))
    codexes = codex(now)
    by_thread = {session["thread"]: session for session in codexes}
    top = list(claudes)

    for session in codexes:
        fresh = now - session["mtime"] <= WORKER_S
        parent = by_thread.get(session["parent"])
        if session["parent"]:
            # A Codex subagent goes under the Codex session that spawned it.
            if parent and fresh:
                parent["workers"].append(as_worker(session, "Codex subagent"))
            continue
        if session["isExec"]:
            # A headless Codex run is some session's worker: the Claude Code
            # session last active in the same project, when there is one.
            root = project_root(session["cwd"])
            hosts = [c for c in claudes if project_root(c["cwd"]) == root]
            if hosts:
                if fresh:
                    host = max(hosts, key=lambda c: (c["state"] == "running", c["mtime"]))
                    host["workers"].append(as_worker(session, "Codex worker"))
                    if session["state"] == "running":
                        host["state"] = "running"
                continue
        top.append(session)

    for session in codexes:
        if any(w["state"] == "running" for w in session["workers"]):
            session["state"] = "running"

    projects = {}
    for session in top:
        root = project_root(session["cwd"])
        node = projects.setdefault(root, {"name": os.path.basename(root) or "session", "root": root, "sessions": []})
        node["sessions"].append({key: session[key] for key in (
            "id", "kind", "model", "state", "startTime", "action", "isOwn", "workers")})

    want = ""
    if "--project" in sys.argv[1:-1]:
        want = sys.argv[sys.argv.index("--project") + 1].lower()
    found = []
    for node in projects.values():
        if want and want not in node["name"].lower():
            continue
        node["sessions"].sort(key=lambda s: (s["state"] != "running", s["kind"]))
        node["sessions"] = node["sessions"][:6]
        found.append(node)
    found.sort(key=lambda n: (not any(s["state"] == "running" for s in n["sessions"]), n["name"]))
    return {"now": int(now * 1000), "projects": found[:12]}


def span(ms_):
    s = max(0, ms_ // 1000)
    return "%ds" % s if s < 60 else "%dm %ds" % (s // 60, s % 60)


MARK = {"running": "●", "waiting": "◷", "done": "✓", "failed": "✗"}


def draw(found):
    out = []
    working = 0
    for project in found["projects"]:
        out.append(project["name"])
        sessions = project["sessions"]
        for i, session in enumerate(sessions):
            last = i == len(sessions) - 1
            bar = "   " if last else "│  "
            took = span(found["now"] - session["startTime"])
            live = session["state"] == "running"
            working += live
            out.append("%s %s %s%s · %s · %s" % (
                "└─" if last else "├─", MARK[session["state"]], session["kind"],
                " (this session)" if session["isOwn"] else "", session["model"],
                took if live else "idle " + took))
            if live:
                out.append("%s   %s" % (bar, session["action"]))
            for j, worker in enumerate(session["workers"]):
                out.append("%s%s %s %s · %s · %s · %s" % (
                    bar, "└─" if j == len(session["workers"]) - 1 else "├─", MARK[worker["state"]],
                    worker["name"], worker["model"],
                    span(found["now"] - worker["startTime"]), worker["action"]))
    head = "%d project%s open · %s" % (
        len(found["projects"]), "" if len(found["projects"]) == 1 else "s",
        "%d working" % working if working else "all quiet")
    return "\n".join([head] + out)


def main():
    if "--watch" in sys.argv:
        try:
            while True:
                sys.stdout.write("\033[2J\033[H" + draw(scan()) + "\n")
                sys.stdout.flush()
                time.sleep(2)
        except KeyboardInterrupt:
            return
    json.dump(scan(), sys.stdout)


if __name__ == "__main__":
    main()
