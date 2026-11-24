export type RowState = 'running' | 'waiting' | 'done' | 'failed'

// One of this session's own subagents, as the engine lists it.
export type AgentRow = {
  id: string
  name: string
  model: string
  state: RowState
  startTime: number
  endTime?: number
  action: string
}

export type Board = {
  rows: AgentRow[]
  now: number
  taskTotal: number
  taskDone: string[]
}

// A worker some session launched: a subagent, or a headless Codex run.
export type Worker = {
  id: string
  name: string
  model: string
  state: RowState
  startTime: number
  action: string
}

// A Codex or Claude Code session open on this machine.
export type SessionNode = {
  id: string
  kind: string
  model: string
  state: RowState
  startTime: number
  action: string
  // True for the session that draws the tree.
  isOwn: boolean
  workers: Worker[]
}

// A project: a git repository's top folder, with the sessions open in it.
export type ProjectNode = { name: string; root: string; sessions: SessionNode[] }

export type Sessions = { projects: ProjectNode[]; now: number }

// What the tree shows. `auto`: this session's workers, only while it has
// any. `session`: this session and its workers, always. `project`: every
// open project, or those whose name holds `project`. `off`: nothing.
export type View = { scope: 'auto' | 'session' | 'project' | 'off'; project: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-tree': {
      board: Shaped<Board>
      actions: Shaped<Record<string, string>>
      sessions: Shaped<Sessions>
      view: Shaped<View>
    }
  }
}
