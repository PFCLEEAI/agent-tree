# agent-tree

A mod for Claude Code (a small plugin that changes its interface).


A live tree above the prompt showing who is working right now. It stays
hidden until you ask, except that this session's own workers show while
they run.

| You type | You see |
| --- | --- |
| nothing (default) | Nothing, except this session's own workers while they run |
| `/agent-tree session` | This session and the workers it launched |
| `/agent-tree project` | Every open project, each session in it, and each session's workers underneath |
| `/agent-tree project voice` | Only projects whose folder name contains "voice" |
| `/agent-tree off` | Nothing at all |

`/agent-tree auto` goes back to the default.

You can also ask in words ("agent tree for the voice agent project") and
Claude sets it. The choice is per session.

```
Projects · 2 open · 2 working · 2 workers
voice-agent
└─ ● Claude Code · opus-5-5 · 1m 0s · 1 worker
     Editing agent.py
   └─ ● Codex: run the call tests · haiku-5-5 · 30s · Ran npm test
pm-agent
├─ ● Claude Code (this session) · fable-5-2 · 1m 0s · 1 worker
│    Thinking
│  └─ ● Codex worker · gpt-6.2-sol · 1m 0s · Ran pytest
└─ ◷ Codex · gpt-6.2-sol · idle 1m 0s
```

How it knows:

- This session's subagents come live from Claude Code and update every second.
- Everything else is read every five seconds, only while a view that shows it
  is on, from the tails of session logs (`~/.codex/sessions`,
  `~/.claude/projects`). Needs `python3`.
- A project is a git repository's top folder; worktrees count as their main
  repository. A session is "open" if its log changed in the last hour.
- Workers are a Claude Code session's subagents, a Codex session's subagents,
  and headless `codex exec` runs, which are placed under the Claude Code
  session last active in the same project.

## Install

From a shell:

```
claude plugin install agent-tree --marketplace PFCLEEAI/agent-tree
```

Or at the prompt of a Claude Code terminal session:

```
/plugin install agent-tree --marketplace PFCLEEAI/agent-tree
```

## The same tree beside Codex

Codex has no place to draw the band, so run the tree in a terminal pane:

```
python3 scripts/sessions.py --watch
python3 scripts/sessions.py --project voice --watch
```
