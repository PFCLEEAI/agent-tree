import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'agent-tree',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 30,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SCAN = {
  now: 60_000,
  projects: [
    {
      name: 'voice-agent',
      root: '/work/voice-agent',
      sessions: [
        {
          id: 'claude:2',
          kind: 'Claude Code',
          model: 'opus-5-5',
          state: 'running',
          startTime: 0,
          action: 'Editing agent.py',
          isOwn: false,
          workers: [
            {
              id: 'agent-1.jsonl',
              name: 'Codex: run the call tests',
              model: 'haiku-5-5',
              state: 'running',
              startTime: 30_000,
              action: 'Ran npm test',
            },
          ],
        },
      ],
    },
    {
      name: 'pm-agent',
      root: '/work/pm-agent',
      sessions: [
        {
          id: 'claude:1',
          kind: 'Claude Code',
          model: 'fable-5-2',
          state: 'running',
          startTime: 0,
          action: 'Thinking',
          isOwn: true,
          workers: [
            {
              id: 'codex:9',
              name: 'Codex worker',
              model: 'gpt-6.2-sol',
              state: 'running',
              startTime: 0,
              action: 'Ran pytest',
            },
          ],
        },
        {
          id: 'codex:1',
          kind: 'Codex',
          model: 'gpt-6.2-sol',
          state: 'waiting',
          startTime: 0,
          action: 'Finished its turn',
          isOwn: false,
          workers: [],
        },
      ],
    },
  ],
}

test('hidden until asked; then this session, or every project with its workers', async ($, on) => {
  let agents: unknown[] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 30_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'agent-tree' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-tree__scope' } }))
  on('process.hookEnv', () => ({ value: {} }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
      stdout: JSON.stringify(SCAN),
    },
  }))
  on('agent.list', () => ({ value: agents as never }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // The default: no workers, so the band is the engine's own and none of ours.
  const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await quiet.find({ type: 'Text', text: /engine/ })).toBeTruthy()
  expect(await quiet.find({ type: 'Text', text: /voice-agent|worker/ })).toBeFalsy()
  await quiet.unmount()

  // Asked for the session: its subagent, live, and the Codex run under it.
  agents = [
    {
      id: 'a1',
      description: 'Check prices',
      type: 'general-purpose',
      status: 'running',
      kind: 'local_agent',
      taskStatus: 'running',
      label: 'Check prices',
      startTime: 0,
      cwd: '/',
      model: 'claude-opus-5-5',
      tokenCount: 0,
      tokenSamples: [],
      hasRow: true,
    },
  ]
  await $.tool.call({ tool: 'TaskCreate', subject: 'one', description: 'one' })
  await $.tool.call({ tool: 'WebFetch', url: 'https://apple.com/mac', prompt: 'p', agentId: 'a1' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'agent-tree', args: 'session' } as never)

  const own = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await own.find({ type: 'Text', text: /Running 2 workers · 0\/1 tasks/ })).toBeTruthy()
  expect(await own.find({ type: 'Text', text: /● Check prices · opus-5-5 · 30s/ })).toBeTruthy()
  expect(await own.find({ type: 'Text', text: /Fetching apple\.com/ })).toBeTruthy()
  expect(await own.find({ type: 'Text', text: /● Codex worker · gpt-6\.2-sol · 1m 0s/ })).toBeTruthy()
  expect(await own.find({ type: 'Text', text: /voice-agent/ })).toBeFalsy()
  await own.unmount()

  // Asked for the projects, as the model sets it when asked in words.
  await $.tool.call({ tool: 'mcp__agent-tree__scope', scope: 'project' })
  const all = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await all.find({ type: 'Text', text: /Projects · 2 open · 2 working · 2 workers/ })).toBeTruthy()
  expect(await all.find({ type: 'Text', text: /^voice-agent$/ })).toBeTruthy()
  expect(await all.find({ type: 'Text', text: /● Claude Code · opus-5-5 · 1m 0s · 1 worker/ })).toBeTruthy()
  expect(
    await all.find({ type: 'Text', text: /└─ ● Codex: run the call tests · haiku-5-5 · 30s · Ran npm test/ }),
  ).toBeTruthy()
  expect(await all.find({ type: 'Text', text: /Claude Code \(this session\) · fable-5-2/ })).toBeTruthy()
  expect(await all.find({ type: 'Text', text: /◷ Codex · gpt-6\.2-sol · idle 1m 0s/ })).toBeTruthy()
  await all.unmount()

  // And off again.
  await $.command.run({ command: 'agent-tree', args: 'off' } as never)
  const off = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await off.find({ type: 'Text', text: /engine/ })).toBeTruthy()
  expect(await off.find({ type: 'Text', text: /Projects/ })).toBeFalsy()
  await off.unmount()
})
