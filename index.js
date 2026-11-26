/**
 * dsh-ego-browser — Host plugin that bridges the DSH agent to the locally
 * installed ego lite browser through its `ego-browser` CLI.
 *
 * Tools:
 *   ego_browser_run      run an ego-browser Node script in the user's real browser
 *   ego_browser_open     open one URL in a task space and return title + snapshot
 *   ego_browser_spaces   list existing task spaces
 *   ego_browser_guide    print the CLI usage guide that matches the installed version
 *
 * Scripts are fed to `ego-browser nodejs` over stdin, so multi-line and non-ASCII
 * bodies survive every shell. When a CLI of the wrong version cannot reach the
 * running browser, the next candidate is tried automatically.
 * @module dsh-ego-browser
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-ego-browser'
export const inject = ['tools']

const IS_WINDOWS = process.platform === 'win32'
const BIN = IS_WINDOWS ? 'ego-browser.exe' : 'ego-browser'

/** Installed ego lite application roots, newest version first inside each. */
const APP_ROOTS = IS_WINDOWS
  ? [
      'C:\\Program Files\\Citro Labs\\ego lite\\Application',
      'C:\\Program Files (x86)\\Citro Labs\\ego lite\\Application',
      'D:\\Program Files\\Citro Labs\\ego lite\\Application',
      'D:\\Program Files (x86)\\Citro Labs\\ego lite\\Application',
    ]
  : [
      '/Applications/ego lite.app/Contents/MacOS',
      '/Applications/ego lite.app/Contents/Resources/app/Application',
      join(homedir(), 'Applications/ego lite.app/Contents/MacOS'),
    ]

/** A bootstrap failure means this CLI cannot reach the running browser. */
const CONNECT_FAILURE = /Failed to connect to ego_cli bootstrap|medium-integrity relay failed|EGO_CLI_BOOTSTRAP/

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 20_000

export const Config = z.object({
  cliPath: z.string()
    .description(`Absolute path to the ego-browser executable. Leave empty to auto-detect (env EGO_BROWSER_CLI also works).`),
  timeoutMs: z.number()
    .description('Default script timeout in milliseconds.')
    .default(DEFAULT_TIMEOUT_MS),
  maxOutputChars: z.number()
    .description('Maximum characters of output returned to the model; longer output is truncated.')
    .default(MAX_OUTPUT_CHARS),
})

/** Version of the ego lite instance that is running now, read from its Mojo pipe name. */
function runningVersion() {
  if (!IS_WINDOWS) return undefined
  try {
    for (const entry of readdirSync('\\\\.\\pipe\\')) {
      const match = /^mojo\.CitroLabs\.ego\.(.+)$/.exec(entry)
      if (match) return match[1]
    }
  } catch {
    // Pipe enumeration is best-effort; fall through to the installed versions.
  }
  return undefined
}

/** Every `ego-browser` on PATH, in PATH order. */
function pathCandidates() {
  const found = []
  const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of entries) {
    const candidate = join(dir, BIN)
    if (existsSync(candidate)) found.push({ cli: candidate, version: undefined, source: 'path' })
  }
  const localBin = join(homedir(), '.local', 'bin', BIN)
  if (existsSync(localBin)) found.push({ cli: localBin, version: undefined, source: 'local-bin' })
  return found
}

/**
 * Candidate CLIs, most likely first: an explicit path, then the build that
 * matches the running browser (a stale build of another version cannot reach
 * it), then the newest installed builds, then anything on PATH.
 */
export function candidateClis(configured, env = process.env) {
  const explicit = configured || env.EGO_BROWSER_CLI
  if (explicit) return [{ cli: explicit, version: undefined, source: 'config' }]

  const result = []
  const seen = new Set()
  const push = (candidate) => {
    if (!candidate || seen.has(candidate.cli) || !existsSync(candidate.cli)) return
    seen.add(candidate.cli)
    result.push(candidate)
  }

  const version = runningVersion()
  const installed = []
  for (const root of APP_ROOTS) {
    if (!existsSync(root)) continue
    let entries = []
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const candidate = join(root, entry, BIN)
      if (existsSync(candidate)) installed.push({ version: entry, cli: candidate, source: 'installed' })
    }
  }
  installed.sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))

  if (version) {
    const running = installed.find((item) => item.version === version)
    if (running) push({ ...running, source: 'running' })
  }
  for (const item of installed) push(item)
  for (const item of pathCandidates()) push(item)
  return result
}

/**
 * Run one ego-browser invocation and collect merged output.
 * `script` is fed to stdin when the command reads one (`nodejs`); commands such
 * as `skill` take no script.
 */
function runScript(cliPath, argv, script, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(cliPath, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    let stderrTail = ''
    let settled = false

    const finish = (error, exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ exitCode, output, durationMs: Date.now() - startedAt })
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`ego-browser did not finish within ${timeoutMs}ms and was stopped`))
    }, timeoutMs)

    const onAbort = () => {
      child.kill()
      finish(new Error('ego-browser call was cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000)
      output += chunk
    })
    child.on('error', (error) => finish(new Error(`could not start ${cliPath}: ${error.message}`)))
    child.on('close', (code, signalName) => {
      if (code !== 0 && !output.trim() && signalName === undefined) {
        finish(new Error(`${cliPath} exited with code ${code}: ${stderrTail.trim() || 'no output'}`))
        return
      }
      finish(undefined, code ?? 0)
    })

    child.stdin.on('error', () => {})
    if (script === undefined) child.stdin.end()
    else child.stdin.end(script)
  })
}

/**
 * Run against the first CLI that can actually reach the browser.
 * Only a bootstrap/relay failure moves on to the next candidate; a command that
 * ran and failed keeps its own output.
 */
async function invoke(configured, script, timeoutMs, signal, argv = ['nodejs']) {
  const candidates = candidateClis(configured)
  if (candidates.length === 0) {
    throw new Error(
      'ego lite was not found. Install it from https://lite.ego.app/, then either finish its onboarding '
      + '(which puts ego-browser on PATH) or set the plugin option cliPath to the ego-browser executable.',
    )
  }
  const failures = []
  for (const candidate of candidates) {
    if (signal?.aborted) throw new Error('ego-browser call was cancelled')
    try {
      const result = await runScript(candidate.cli, argv, script, timeoutMs, signal)
      const unreachable = result.exitCode !== 0 && CONNECT_FAILURE.test(result.output)
      if (!unreachable) return { ...result, cli: candidate.cli, version: candidate.version, source: candidate.source }
      failures.push(`${candidate.cli}: ${result.output.trim().split(/\r?\n/)[0]}`)
    } catch (error) {
      if (!CONNECT_FAILURE.test(String(error?.message))) throw error
      failures.push(`${candidate.cli}: ${error.message}`)
    }
  }
  throw new Error(
    'No installed ego-browser could reach the running ego lite browser. Start ego lite, then set cliPath to '
    + `the executable of the same version.\nTried:\n${failures.join('\n')}`,
  )
}

/** Strip ego's own update notice so it does not drown the real output. */
function cleanOutput(text, maxChars) {
  const filtered = text
    .split(/\r?\n/)
    .filter((line) => !/\[ego-browser:notice\]/.test(line))
    .join('\n')
    .trim()
  const truncated = filtered.length > maxChars
  return {
    text: truncated ? `${filtered.slice(0, maxChars)}\n…(output truncated at ${maxChars} characters)` : filtered,
    truncated,
  }
}

/** Parse the `KEY=value` lines a script prints; keys come back lowercase. */
function parseFields(text) {
  const fields = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match) fields[match[1].toLowerCase()] = match[2]
  }
  return fields
}

/** JSON-encode a value so it embeds safely in a generated script. */
function literal(value) {
  return JSON.stringify(value)
}

export function apply(ctx, config) {
  const resolved = Config(config ?? {})
  const timeoutDefault = resolved.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutput = resolved.maxOutputChars ?? MAX_OUTPUT_CHARS

  ctx.effect(() => {
    const disposeRun = ctx.tools.register(defineTool({
      name: 'ego_browser_run',
      description:
        'Run an ego-browser Node.js script inside the user\'s real ego lite browser profile. The script '
        + 'gets the ego TaskSpace/Page helpers (taskSpace, listTaskSpaces, page.goto, page.snapshot, '
        + 'page.click, page.fill, page.screenshot, page.evaluate, page.fetch, waitForEvent, ...) and runs '
        + 'as a module, so top-level await works and console.log lines come back as output. Use it for '
        + 'browser automation the user asked for; keep one task space per goal and end with '
        + '`await task.finish({ keep: [] })` unless the user wants the page kept open.',
      parameters: {
        script: {
          type: 'string',
          required: true,
          description:
            'Complete ego-browser script body (ES module, top-level await allowed). Print results with '
            + 'console.log, ideally as uppercase KEY=value lines such as TITLE=... so they come back as fields.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds. Defaults to the plugin timeoutMs option.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', description: 'Whether the script exited with code 0.' },
            exitCode: { type: 'integer' },
            durationMs: { type: 'integer' },
            cli: { type: 'string', description: 'ego-browser executable used for this run.' },
            version: { type: 'string', description: 'ego lite version of that CLI when known.' },
            output: { type: 'string', description: 'Merged stdout and stderr of the script.' },
            truncated: { type: 'boolean' },
            fields: {
              type: 'object',
              additionalProperties: true,
              description: 'Uppercase KEY=value lines parsed from the output, keyed lowercase.',
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? `ego-browser script finished in ${value.durationMs}ms.\n${value.output}`
            : `ego-browser script failed (exit ${value.exitCode}).\n${value.output}`,
        }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Run ego-browser script',
        kind: 'execute',
        rawInput: args.script.length > 400 ? `${args.script.slice(0, 400)}\n…` : args.script,
      }),
      async execute(args, exec) {
        const timeoutMs = Math.min(Math.max(args.timeoutMs ?? timeoutDefault, 1000), 900_000)
        const result = await invoke(resolved.cliPath, args.script, timeoutMs, exec.signal)
        const { text, truncated } = cleanOutput(result.output, maxOutput)
        return {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          cli: result.cli,
          version: result.version ?? '',
          output: text,
          truncated,
          fields: parseFields(text),
        }
      },
    }))

    const disposeOpen = ctx.tools.register(defineTool({
      name: 'ego_browser_open',
      description:
        'Open one URL in an ego lite task space and return the page title, the visible page text, and an '
        + 'accessibility snapshot. Shortcut for "open this page and tell me what is on it"; use '
        + 'ego_browser_run for anything interactive.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
        task: {
          type: 'string',
          description: 'Task space name. Reuse the same name to continue in one space; defaults to the URL host.',
        },
        keep: {
          type: 'boolean',
          description: 'Keep the task space open for the user after the call. Defaults to false (close it).',
        },
        maxSnapshotChars: {
          type: 'number',
          description: 'Maximum characters of page text and snapshot returned. Defaults to 8000.',
        },
        timeoutMs: { type: 'number', description: 'Navigation and script timeout in milliseconds.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            spaceId: { type: 'integer' },
            page: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string' },
            snapshot: { type: 'string' },
            output: { type: 'string', description: 'Raw script output, for diagnosis.' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? `Opened ${value.url}\nTitle: ${value.title}\nTask space: ${value.spaceId} (page ${value.page})\n\n${value.snapshot}`
            : `Could not open the page.\n${value.output}`,
        }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Open ${args.url}`,
        kind: 'read',
        rawInput: args.url,
      }),
      async execute(args, exec) {
        const spaceName = args.task
          ?? (() => {
            try { return new URL(args.url).hostname || 'ego-browser' } catch { return 'ego-browser' }
          })()
        const timeoutMs = Math.min(Math.max(args.timeoutMs ?? timeoutDefault, 5000), 600_000)
        const navTimeout = Math.max(Math.floor(timeoutMs * 0.8), 5000)
        const maxSnapshot = Math.min(Math.max(args.maxSnapshotChars ?? 8000, 500), 60_000)
        const script = [
          `const spaces = await listTaskSpaces();`,
          `let t = spaces.find((s) => s.name === ${literal(spaceName)});`,
          `t = t === undefined ? await taskSpace(${literal(spaceName)}) : await taskSpace(t.id);`,
          `const p = t.page('p1');`,
          `await p.goto(${literal(args.url)}, { timeout: ${navTimeout} });`,
          `console.log('TITLE=' + (await p.title()));`,
          `console.log('URL=' + (await p.url()));`,
          `console.log('SPACE=' + t.spaceId);`,
          `console.log('PAGE=' + p.label);`,
          `console.log('BODY<<<');`,
          `console.log((await p.evaluate(() => document.body ? document.body.innerText.slice(0, ${maxSnapshot}) : '')).trim());`,
          `console.log('>>>BODY');`,
          `console.log('SNAPSHOT<<<');`,
          `console.log((await p.snapshot()).slice(0, ${maxSnapshot}));`,
          `console.log('>>>SNAPSHOT');`,
          args.keep ? '' : `await t.finish({ keep: [] });`,
        ].filter(Boolean).join('\n')

        const result = await invoke(resolved.cliPath, script, timeoutMs, exec.signal)
        const raw = result.output
        const between = (start, end) => new RegExp(`${start}<<<\\r?\\n([\\s\\S]*?)\\r?\\n>>>${end}`).exec(raw)?.[1] ?? ''
        const snapshot = between('SNAPSHOT', 'SNAPSHOT')
        const body = between('BODY', 'BODY')
        const title = /^TITLE=(.*)$/m.exec(raw)?.[1] ?? ''
        const url = /^URL=(.*)$/m.exec(raw)?.[1] ?? ''
        const spaceId = Number(/^SPACE=(\d+)$/m.exec(raw)?.[1] ?? -1)
        const page = /^PAGE=(\S+)$/m.exec(raw)?.[1] ?? ''
        return {
          ok: result.exitCode === 0 && (snapshot.length > 0 || body.length > 0),
          spaceId,
          page,
          url,
          title,
          snapshot: body.length > 0
            ? `Visible text:\n${body}\n\nAccessibility snapshot:\n${snapshot}`
            : snapshot,
          output: raw.slice(0, 4000),
        }
      },
    }))

    const disposeSpaces = ctx.tools.register(defineTool({
      name: 'ego_browser_spaces',
      description:
        'List the ego lite task spaces that exist now, with ids, names, and ownership, so a later '
        + 'ego_browser_run can reuse one instead of opening a new browser space.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            spaces: { type: 'string', description: 'JSON array of task spaces.' },
            output: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.ok ? value.spaces : value.output }],
      },
      async execute(_args, exec) {
        const script = [
          `const spaces = await listTaskSpaces();`,
          `console.log('SPACES=' + JSON.stringify(spaces.map((s) => ({ id: s.id, name: s.name, ownership: s.ownership }))));`,
        ].join('\n')
        const result = await invoke(resolved.cliPath, script, Math.min(timeoutDefault, 60_000), exec.signal)
        const spaces = /^SPACES=(.*)$/m.exec(result.output)?.[1] ?? '[]'
        return { ok: result.exitCode === 0, spaces, output: result.output.slice(0, 4000) }
      },
    }))

    const disposeGuide = ctx.tools.register(defineTool({
      name: 'ego_browser_guide',
      description:
        'Print the ego-browser usage guide that matches the installed CLI: the TaskSpace, Page, selector, '
        + 'screenshot, download, and cleanup APIs an ego_browser_run script may call. Read it before '
        + 'writing a script that uses an API you have not used yet.',
      parameters: {
        maxChars: {
          type: 'number',
          description: 'Maximum guide characters returned. Defaults to 12000.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            version: { type: 'string', description: 'Guide version line, when printed.' },
            guide: { type: 'string' },
            output: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok ? value.guide : `Could not read the ego-browser guide.\n${value.output}`,
        }],
      },
      async execute(args, exec) {
        const maxChars = Math.min(Math.max(args.maxChars ?? 12_000, 1000), 120_000)
        const result = await invoke(resolved.cliPath, undefined, 60_000, exec.signal, ['skill'])
        const version = /ego-browser usage guide ([^\s(]+)/.exec(result.output)?.[1] ?? ''
        return {
          ok: result.exitCode === 0,
          version,
          guide: result.output.slice(0, maxChars),
          output: result.output.slice(0, 2000),
        }
      },
    }))

    return () => {
      disposeRun()
      disposeOpen()
      disposeSpaces()
      disposeGuide()
    }
  })
}

/** Exposed for tests and diagnostics. */
export const internals = { candidateClis, cleanOutput, parseFields, runningVersion }
