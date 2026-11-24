import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, Board, ProjectNode, RowState, Sessions, View } from '../types'

const EMPTY: Board = { rows: [], now: 0, taskTotal: 0, taskDone: [] }
const NONE: Sessions = { projects: [], now: 0 }
const AUTO: View = { scope: 'auto', project: '' }
const SCOPE_TOOL = 'mcp__agent-tree__scope'
// How long a finished subagent stays in the tree.
const LINGER_MS = 20_000
// How often the other sessions' logs are read, while a view needs them.
const POLL_MS = 5000

const board = atom({ plugin: 'agent-tree', key: 'board' } as const, EMPTY, {
  shape: 'board-1',
})
const actions = atom({ plugin: 'agent-tree', key: 'actions' } as const, {}, {
  shape: 'actions-1',
})
const sessions = atom({ plugin: 'agent-tree', key: 'sessions' } as const, NONE, {
  shape: 'sessions-3',
})
const view = atom({ plugin: 'agent-tree', key: 'view' } as const, AUTO, {
  shape: 'view-2',
})

let ticker: Timer | undefined
let poller: Timer | undefined
let env: Record<string, string> | undefined

const MARK = { running: '●', waiting: '◷', done: '✓', failed: '✗' }

const shortModel = (model: string | undefined): string =>
  (model ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '')

const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))

  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`

  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').trim()

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const host = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// "name · model · time", the model left out where none is known.
const head = (name: string, model: string, time: string): string =>
  `${name}${model === '' ? '' : ` · ${model}`} · ${time}`

// One line saying what a tool call is doing, as "Fetching apple.com".
const describe = (tool: string, input: Record<string, unknown>): string => {
  const path = str(input.file_path)
  const base = path?.split('/').pop()

  if (tool === 'WebFetch' && str(input.url)) return `Fetching ${host(str(input.url) ?? '')}`
  if (tool === 'WebSearch' && str(input.query)) return `Searching "${str(input.query)}"`
  if (tool === 'Bash') return firstLine(str(input.description) ?? str(input.command) ?? 'Running a command')
  if (tool === 'Read' && base) return `Reading ${base}`
  if ((tool === 'Edit' || tool === 'Write') && base) return `Editing ${base}`
  if ((tool === 'Grep' || tool === 'Glob') && str(input.pattern)) return `Searching ${str(input.pattern)}`

  return tool
}

type Line = { text: string; isDim?: boolean; isBold?: boolean }

// This session's own workers: its subagents, live from the engine, then the
// Codex runs the log scan found under it.
const ownLines = (mine: Board, seen: Sessions): Line[] => {
  const own = seen.projects.flatMap(project => project.sessions).find(one => one.isOwn)
  const rows = [
    ...mine.rows.map(row => ({
      state: row.state,
      title: head(row.name, row.model, elapsed((row.endTime ?? mine.now) - row.startTime)),
      action: row.action,
      isOver: row.endTime !== undefined,
    })),
    // The scan's Claude subagents are the engine's own rows above: only its Codex runs are new.
    ...(own?.workers ?? [])
      .filter(worker => worker.id.startsWith('codex:'))
      .map(worker => ({
        state: worker.state,
        title: head(worker.name, worker.model, elapsed(seen.now - worker.startTime)),
        action: worker.action,
        isOver: worker.state !== 'running',
      })),
  ]

  return rows.flatMap((row, i) => {
    const isLast = i === rows.length - 1

    return [
      { text: `${isLast ? '└─' : '├─'} ${MARK[row.state]} ${row.title}`, isDim: row.isOver },
      { text: `${isLast ? '  ' : '│ '}   ${row.action}`, isDim: true },
    ]
  })
}

// Every project in view: its sessions, and under each the workers it launched.
const projectLines = (projects: ProjectNode[], now: number): Line[] =>
  projects.flatMap(project => [
    { text: project.name, isBold: true },
    ...project.sessions.flatMap((one, i) => {
      const isLast = i === project.sessions.length - 1
      const bar = isLast ? '   ' : '│  '
      const isLive = one.state === 'running'
      const took = elapsed(now - one.startTime)
      const kind = `${one.kind}${one.isOwn ? ' (this session)' : ''}`
      const workers = one.workers.length === 0 ? '' : ` · ${plural(one.workers.length, 'worker')}`

      return [
        {
          text:
            `${isLast ? '└─' : '├─'} ${MARK[one.state]} ` +
            head(kind, one.model, isLive ? took : `idle ${took}`) +
            workers,
          isDim: !isLive,
        },
        ...(isLive ? [{ text: `${bar}  ${one.action}`, isDim: true }] : []),
        ...one.workers.map((worker, j) => ({
          text:
            `${bar}${j === one.workers.length - 1 ? '└─' : '├─'} ${MARK[worker.state]} ` +
            `${head(worker.name, worker.model, elapsed(now - worker.startTime))} · ${worker.action}`,
          isDim: worker.state !== 'running',
        })),
      ]
    }),
  ])

// Reads the engine's subagents into the board; resolves whether any row is left.
async function refresh($: EngineInterface): Promise<boolean> {
  const [list, now, acts] = await Promise.all([
    $.agent.list(),
    $.clock.now(),
    read($, actions),
  ])
  let count = 0
  await update($, board, old => {
    const before = new Map(old.rows.map(row => [row.id, row]))
    const rows: AgentRow[] = []

    for (const agent of list) {
      const isActive = ['pending', 'running', 'waiting', 'idle'].includes(agent.status)
      const state: RowState =
        agent.status === 'running' || agent.status === 'pending'
          ? 'running'
          : isActive
            ? 'waiting'
            : agent.status === 'completed'
              ? 'done'
              : 'failed'
      const endTime = isActive ? undefined : (before.get(agent.id)?.endTime ?? now)

      if (endTime !== undefined && now - endTime > LINGER_MS) continue

      rows.push({
        id: agent.id,
        name: agent.name ?? agent.description,
        model: shortModel(agent.model),
        state,
        startTime: agent.startTime,
        endTime,
        action: isActive
          ? (acts[agent.id] ?? firstLine(agent.label))
          : state === 'done'
            ? 'Done'
            : 'Stopped',
      })
    }
    count = rows.length

    return { ...old, rows, now }
  })

  return count > 0
}

// Ticks once a second while a subagent is in the tree.
function watch($: EngineInterface): void {
  if (ticker) return
  ticker = $.clock.every(1000, async () => {
    if (!(await refresh($))) {
      ticker?.cancel()
      ticker = undefined
    }
  })
}

// Reads the sessions open on this machine, where the view in use shows them.
async function poll($: EngineInterface): Promise<void> {
  try {
    const { scope, project } = await read($, view)

    // Nothing of the scan is drawn: no process is started.
    if (scope === 'off' || scope === 'auto') return

    env ??= await $.process.hookEnv()
    const ran = await $.process.run(
      [
        '/usr/bin/env',
        'python3',
        '-B',
        `${$.plugin.root}/scripts/sessions.py`,
        ...(scope === 'project' && project !== '' ? ['--project', project, '--json'] : []),
      ],
      { env, timeoutMs: 4000 },
    )

    if (ran.exitCode !== 0) return

    const found = JSON.parse(ran.stdout) as Sessions
    const projects = Array.isArray(found.projects) ? found.projects : []

    await update($, sessions, () => ({ projects, now: found.now }))
  } catch {
    // A scan that fails leaves the last tree standing.
  }
}

function survey($: EngineInterface): void {
  if (poller) return
  poller = $.clock.every(POLL_MS, () => poll($))
}

// Sets what the tree shows from words like "project voice"; resolves a line
// saying what it shows now, or how to ask.
async function choose($: EngineInterface, words: string): Promise<string> {
  const [first = '', ...rest] = words.trim().split(/\s+/)
  const scope = first.toLowerCase()
  const project = rest.join(' ').trim()
  const said: Record<string, [View, string]> = {
    off: [{ scope: 'off', project: '' }, 'Agent tree is off.'],
    auto: [AUTO, "Agent tree: shown only while this session's own workers run."],
    session: [{ scope: 'session', project: '' }, 'Agent tree: this session and the workers it launched.'],
    project: [
      { scope: 'project', project },
      project === ''
        ? 'Agent tree: every open project, its sessions and their workers.'
        : `Agent tree: projects whose name contains "${project}".`,
    ],
  }
  const picked = said[scope === 'projects' || scope === 'all' ? 'project' : scope === 'hide' ? 'off' : scope]

  if (picked === undefined) {
    const now = await read($, view)

    return (
      `Agent tree is set to: ${now.scope}${now.project === '' ? '' : ` ${now.project}`}. ` +
      'Use /agent-tree session, /agent-tree project, /agent-tree project <name>, /agent-tree auto or /agent-tree off.'
    )
  }

  await update($, view, () => picked[0])
  await poll($)

  return picked[1]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'agent-tree',
      description: 'Show who is working: this session and its workers, or every open project',
      argumentHint: 'session | project [name] | auto | off',
    })
    await $.tool.register({
      name: 'scope',
      description:
        'Sets what the agent tree above the prompt shows. Call it when the person asks for the agent tree: ' +
        '"session" for this session and the workers it launched; "project" for every open project with its ' +
        'sessions and their workers (with `project`, a part of a project name, for that project alone); ' +
        '"off" to hide it; "auto" to show it only while this session has workers running (the default).',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['session', 'project', 'auto', 'off'] },
          project: { type: 'string', description: "A part of the project's folder name" },
        },
        required: ['scope'],
      },
    })

    if (await refresh($)) watch($)

    await poll($)
    survey($)

    return started
  })

  on('command.run', { command: 'agent-tree' }, async ($, e) => ({
    text: await choose($, e.args),
  }))

  on('tool.call', { tool: SCOPE_TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>

    return { result: await choose($, `${str(input.scope) ?? ''} ${str(input.project) ?? ''}`) }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await refresh($)
    watch($)

    return spawned
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const agentId = e.agentId

    if (agentId !== undefined) {
      const line = describe(e.tool, input)
      await update($, actions, old => ({ ...old, [agentId]: line }))
    }

    if (e.tool === 'TaskCreate') {
      await update($, board, old => ({ ...old, taskTotal: old.taskTotal + 1 }))
    }

    const taskId = str(input.taskId)

    if (e.tool === 'TaskUpdate' && taskId !== undefined) {
      const status = str(input.status)

      if (status === 'completed') {
        await update($, board, old =>
          old.taskDone.includes(taskId) ? old : { ...old, taskDone: [...old.taskDone, taskId] },
        )
      }

      if (status === 'deleted') {
        await update($, board, old => ({
          ...old,
          taskTotal: Math.max(0, old.taskTotal - 1),
          taskDone: old.taskDone.filter(id => id !== taskId),
        }))
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { scope, project } = await read($, view)
    const mine = await read($, board)

    if (e.props.hasSurvey || scope === 'off' || (scope === 'auto' && mine.rows.length === 0)) {
      return next(e)
    }

    const seen = scope === 'auto' ? NONE : await read($, sessions)
    const tasks = mine.taskTotal > 0 ? ` · ${mine.taskDone.length}/${mine.taskTotal} tasks` : ''
    let title: string
    let lines: Line[]

    if (scope === 'project') {
      const all = seen.projects.flatMap(one => one.sessions)
      const working = all.filter(one => one.state === 'running').length
      const workers = all.reduce((n, one) => n + one.workers.length, 0)

      title =
        `${project === '' ? 'Projects' : `Project "${project}"`} · ${seen.projects.length} open` +
        ` · ${working > 0 ? `${working} working` : 'all quiet'} · ${plural(workers, 'worker')}`
      lines = projectLines(seen.projects, seen.now)
    } else {
      lines = ownLines(mine, seen)
      const running = lines.filter(line => line.text.includes(MARK.running)).length

      title =
        (lines.length === 0
          ? 'This session · no workers'
          : running > 0
            ? `Running ${plural(running, 'worker')}`
            : 'Workers finished') + tasks
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        {lines.map(line => (
          <Text bold={line.isBold} dimColor={line.isDim} wrap="truncate-end">
            {line.text}
          </Text>
        ))}
      </Box>
    )
  })
}
