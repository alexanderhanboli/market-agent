import './installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import { act, Profiler, StrictMode, useEffect, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, createRoutesFromElements, Outlet, Route, RouterProvider, useLocation, useNavigate } from 'react-router-dom'

import { BlockRegistryProvider, createDefaultBlockRegistry } from '../blocks/index.ts'
import type { ChatMessage } from '../chat/messageTypes.ts'
import { AuthContext } from '../shell/authTypes.ts'
import { ChatLayout } from './ChatPage.tsx'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const ANSWER = "NVIDIA's revenue rose"
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  get params(): URLSearchParams {
    return new URL(this.url, 'http://localhost').searchParams
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close() {
    this.closed = true
  }

  // A real EventSource stops delivering once closed.
  emit(type: string, seq: number, payload: Record<string, unknown> = {}) {
    if (this.closed) return
    const data = JSON.stringify({
      type,
      seq,
      thread_id: '',
      run_id: this.params.get('run_id'),
      turn_id: this.params.get('turn_id'),
      ...payload,
    })
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }))
  }
}

type Write = [method: string, path: string, body: string]
type Reply = { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>

function block(id: string, text: string) {
  return {
    id,
    kind: 'rich_text',
    snapshot_id: '11111111-1111-4111-8111-111111111111',
    data_ref: { kind: 'chat_turn', id },
    source_refs: [],
    as_of: '2026-05-06T00:00:00.000Z',
    segments: [{ type: 'text', text }],
  }
}

function chatMessage(threadId: string, id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    message_id: id,
    thread_id: threadId,
    role,
    snapshot_id: '11111111-1111-4111-8111-111111111111',
    blocks: [block(`${id}-block`, text)],
    content_hash: `sha256:${id}`,
    created_at: '2026-05-06T00:00:00.000Z',
    ...extra,
  } as ChatMessage
}

function sealedAnswer(threadId: string): ChatMessage {
  return chatMessage(threadId, 'a1', 'assistant', ANSWER, {
    block_proofs: { 'a1-block': { evidence: 'linked', calculation: 'not_verified', public_by_cutoff: 'unknown' } },
  })
}

class FakeServer {
  readonly log: Write[] = []
  readonly posted = new Map<string, ChatMessage>()
  threads: Array<{ thread_id: string; title: string | null; updated_at: string }> = []
  createdThreadId = 'T1'
  history: (threadId: string) => Reply = () => ({ body: { messages: [] } })
  createReply: () => Reply = () => ({ status: 201, body: this.createThread() })
  listReply: () => Reply = () => ({ body: { threads: this.threads } })
  postReply: (message: ChatMessage) => Reply = (message) => ({ status: 201, body: { message } })

  createThread() {
    const thread = { thread_id: this.createdThreadId, title: null, updated_at: '2026-05-06T00:00:00.000Z' }
    this.threads = [thread, ...this.threads]
    return thread
  }

  writes(): Write[] {
    return this.log.filter(([method]) => method !== 'GET')
  }

  gets(path: string): number {
    return this.log.filter(([method, logged]) => method === 'GET' && logged === path).length
  }

  postedUser(threadId: string): ChatMessage {
    return [...this.posted.values()].find((message) => message.thread_id === threadId)!
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const path = String(input)
    const body = init?.body === undefined ? '' : String(init.body)
    this.log.push([method, path, body])
    const reply = await this.route(method, path, body)
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }

  private route(method: string, path: string, body: string): Reply {
    if (path === '/v1/chat/threads' && method === 'GET') return this.listReply()
    if (path === '/v1/chat/threads' && method === 'POST') return this.createReply()
    const match = /^\/v1\/chat\/threads\/([^/]+)\/messages$/.exec(path)
    if (match && method === 'POST') {
      const posted = JSON.parse(body) as { message_id: string; content: string }
      const message = chatMessage(match[1], posted.message_id, 'user', posted.content)
      this.posted.set(posted.message_id, message)
      return this.postReply(message)
    }
    if (match && method === 'GET') return this.history(match[1])
    throw new Error(`unexpected request ${method} ${path}`)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function LocationProbe({ onPath, onNavigate }: { onPath: (path: string) => void; onNavigate: (navigate: (to: string) => void) => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => onPath(location.pathname), [location.pathname, onPath])
  useEffect(() => onNavigate(navigate), [navigate, onNavigate])
  return null
}

type Harness = {
  dom: JSDOM
  container: HTMLElement
  server: FakeServer
  frames: string[]
  path: () => string
  navigate: (to: string) => Promise<void>
  text: () => string
  query: (selector: string) => Element | null
  button: (name: string) => HTMLButtonElement
  flush: () => Promise<void>
  type: (text: string) => Promise<void>
  ask: (text: string, presses?: number) => Promise<void>
  unmount: () => Promise<void>
  cleanup: () => Promise<void>
}

type RenderOptions = {
  strict?: boolean
  // Holds every navigation into a thread uncommitted, the way a slow CPU
  // leaves react-router's navigation transition behind the stream's updates.
  threadRoute?: Promise<unknown>
}

async function renderChat(initialPath: string, server: FakeServer, options: RenderOptions = {}): Promise<Harness> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = Object.fromEntries(['IS_REACT_ACT_ENVIRONMENT', 'document', 'window', 'ResizeObserver', 'EventSource', 'fetch']
    .map((key) => [key, globals[key]]))
  globals.IS_REACT_ACT_ENVIRONMENT = true
  globals.document = dom.window.document
  globals.window = dom.window
  globals.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  FakeEventSource.instances = []
  globals.EventSource = FakeEventSource
  globals.fetch = server.fetch

  const container = dom.window.document.getElementById('root')!
  const frames: string[] = []
  let currentPath = initialPath
  const onPath = (path: string) => {
    currentPath = path
  }
  let routerNavigate: (to: string) => void = () => assert.fail('router not mounted')
  const onNavigate = (navigate: (to: string) => void) => {
    routerNavigate = navigate
  }
  const threadRoute = options.threadRoute
  const router = createMemoryRouter(createRoutesFromElements(
    <Route element={<><Outlet /><LocationProbe onPath={onPath} onNavigate={onNavigate} /></>}>
      <Route path="/chat" element={<ChatLayout />}>
        <Route path=":threadId" loader={threadRoute ? () => threadRoute : undefined} />
      </Route>
      <Route path="/home" element={<p>Home</p>} />
    </Route>,
  ), { initialEntries: [initialPath] })
  const tree: ReactElement = (
    <Profiler id="chat" onRender={() => frames.push(container.textContent ?? '')}>
      <AuthContext.Provider value={{ session: { userId: USER_ID, displayName: 'Test User' }, signIn: () => undefined, signOut: () => undefined }}>
        <BlockRegistryProvider registry={createDefaultBlockRegistry()}>
          <RouterProvider router={router} />
        </BlockRegistryProvider>
      </AuthContext.Provider>
    </Profiler>
  )
  const root = createRoot(container)
  const flush = () => act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  })
  await act(async () => root.render(options.strict ? <StrictMode>{tree}</StrictMode> : tree))
  await flush()
  let mounted = true
  const unmount = async () => {
    if (!mounted) return
    mounted = false
    await act(async () => root.unmount())
  }

  const harness: Harness = {
    dom,
    container,
    server,
    frames,
    path: () => currentPath,
    navigate: async (to) => {
      await act(async () => routerNavigate(to))
      await flush()
    },
    text: () => container.textContent ?? '',
    query: (selector) => container.querySelector(selector),
    button: (name) => {
      const found = [...container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === name || button.textContent === name,
      )
      assert.ok(found, `button "${name}" is rendered`)
      return found as HTMLButtonElement
    },
    flush,
    type: async (text) => {
      const textarea = container.querySelector('textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
        textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    },
    ask: async (text, presses = 1) => {
      await harness.type(text)
      const textarea = container.querySelector('textarea')!
      await act(async () => {
        for (let i = 0; i < presses; i++) {
          textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        }
      })
      await flush()
    },
    unmount,
    cleanup: async () => {
      await unmount()
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globals[key]
        else globals[key] = value
      }
    },
  }
  return harness
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

async function streamAnswer(h: Harness, source: FakeEventSource) {
  await act(async () => {
    source.emit('turn.started', 1)
    source.emit('block.began', 2, { block_id: 'b1', kind: 'rich_text' })
    source.emit('block.delta', 3, { block_id: 'b1', delta: { segment: { type: 'text', text: ANSWER } } })
    source.emit('block.completed', 4, { block_id: 'b1', content_hash: 'h1' })
  })
  await h.flush()
}

async function complete(h: Harness, source: FakeEventSource) {
  await act(async () => source.emit('turn.completed', 5, { message_id: 'a1' }))
  await h.flush()
}

test('every commit from the first streamed text through the hand-off shows the answer exactly once', async () => {
  const server = new FakeServer()
  const sealedLoad = deferred<{ body: unknown }>()
  server.history = () => sealedLoad.promise
  const h = await renderChat('/chat', server)
  try {
    await h.ask('Analyze NVDA')
    assert.equal(h.path(), '/chat/T1')
    await streamAnswer(h, FakeEventSource.instances[0])
    await complete(h, FakeEventSource.instances[0])

    assert.equal(h.query('[data-testid="streaming-turn"]')?.getAttribute('data-turn-status'), 'sealing')
    assert.equal(server.gets('/v1/chat/threads/T1/messages'), 1)
    const listBefore = h.query('[data-testid="virtualized-message-list"]')
    assert.notEqual(listBefore, null)

    await act(async () => sealedLoad.resolve({ body: { messages: [server.postedUser('T1'), sealedAnswer('T1')] } }))
    await h.flush()

    const first = h.frames.findIndex((frame) => frame.includes(ANSWER))
    assert.notEqual(first, -1)
    assert.deepEqual(
      h.frames.slice(first).map((frame) => occurrences(frame, ANSWER)).filter((count) => count !== 1),
      [],
    )
    assert.deepEqual(h.frames.filter((frame) => frame.includes('Loading message history.')), [])
    assert.equal(h.query('[data-testid="virtualized-message-list"]'), listBefore)
    assert.equal(h.query('[data-role="assistant"]')?.textContent?.includes(ANSWER), true)
    assert.equal(h.container.querySelectorAll('[data-testid="streaming-turn"]').length, 0)
  } finally {
    await h.cleanup()
  }
})

test('ask first keeps the answer on screen through the hand-off while the thread route has not committed', async () => {
  const server = new FakeServer()
  const sealedLoad = deferred<{ body: unknown }>()
  server.history = () => sealedLoad.promise
  const threadRoute = deferred<null>()
  const h = await renderChat('/chat', server, { threadRoute: threadRoute.promise })
  try {
    await h.ask('Analyze NVDA')
    await streamAnswer(h, FakeEventSource.instances[0])
    await complete(h, FakeEventSource.instances[0])
    const list = h.query('[data-testid="virtualized-message-list"]')

    await act(async () => sealedLoad.resolve({ body: { messages: [server.postedUser('T1'), sealedAnswer('T1')] } }))
    await h.flush()

    assert.equal(h.path(), '/chat')
    const first = h.frames.findIndex((frame) => frame.includes(ANSWER))
    assert.notEqual(first, -1)
    assert.deepEqual(
      h.frames.slice(first).map((frame) => occurrences(frame, ANSWER)).filter((count) => count !== 1),
      [],
    )
    assert.equal(h.query('[data-role="assistant"]')?.textContent?.includes(ANSWER), true)
    assert.notEqual(list, null)
    assert.equal(h.query('[data-testid="virtualized-message-list"]'), list)

    await act(async () => threadRoute.resolve(null))
    await h.flush()
    assert.equal(h.path(), '/chat/T1')
    assert.equal(h.query('[data-testid="virtualized-message-list"]'), list)
    assert.equal(occurrences(h.text(), ANSWER), 1)
  } finally {
    await h.cleanup()
  }
})

test('ask first under StrictMode creates the thread, posts the question and opens one stream', async () => {
  const server = new FakeServer()
  const h = await renderChat('/chat', server, { strict: true })
  try {
    await h.ask('Analyze NVDA')

    const writes = server.writes()
    assert.deepEqual(writes.map(([method, path]) => [method, path]), [
      ['POST', '/v1/chat/threads'],
      ['POST', '/v1/chat/threads/T1/messages'],
    ])
    assert.equal(writes[0][2], '{"title":null}')
    const posted = JSON.parse(writes[1][2]) as Record<string, string>
    assert.deepEqual(Object.keys(posted), ['message_id', 'snapshot_id', 'content'])
    assert.equal(posted.content, 'Analyze NVDA')
    assert.equal(FakeEventSource.instances.length, 1)
    assert.match(FakeEventSource.instances[0].url, /^\/v1\/chat\/threads\/T1\/stream\?/)
    assert.match(FakeEventSource.instances[0].url, /user_intent=Analyze\+NVDA/)
    assert.equal(FakeEventSource.instances[0].params.get('turn_id'), posted.message_id)
    assert.equal(h.path(), '/chat/T1')
    assert.equal(h.query('[data-testid="thread-name"]')?.textContent, 'Analyze NVDA')
    assert.equal(h.query('[data-role="user"]')?.textContent, 'Analyze NVDA')
    assert.equal(h.button('Send').disabled, true)
  } finally {
    await h.cleanup()
  }
})

test('two Enter presses in one act post the question once and keep the second as a no-op', async () => {
  const server = new FakeServer()
  server.threads = [{ thread_id: 'T1', title: 'Chips', updated_at: '2026-05-06T00:00:00.000Z' }]
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA', 2)
    assert.deepEqual(server.writes().map(([method, path]) => [method, path]), [['POST', '/v1/chat/threads/T1/messages']])
    assert.equal(FakeEventSource.instances.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('the header and the active row show the question, then the server title once the follow-up finds it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const threadId = '6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5'
  const server = new FakeServer()
  server.createdThreadId = threadId
  server.history = (id) => ({ body: { messages: [server.postedUser(id), sealedAnswer(id)] } })
  const h = await renderChat('/chat', server)
  try {
    await h.ask('Analyze NVDA')
    await streamAnswer(h, FakeEventSource.instances[0])
    await complete(h, FakeEventSource.instances[0])
    assert.equal(h.query('[data-testid="streaming-turn"]'), null)

    const header = () => h.query('[data-testid="thread-name"]')?.textContent
    const activeRow = () => h.query('[aria-current="page"] span')?.textContent
    assert.equal(header(), 'Analyze NVDA')
    assert.equal(activeRow(), 'Analyze NVDA')
    assert.doesNotMatch(h.text(), UUID_PATTERN)
    const listReads = server.gets('/v1/chat/threads')

    t.mock.timers.tick(0)
    await h.flush()
    assert.equal(server.gets('/v1/chat/threads'), listReads + 1)
    assert.equal(header(), 'Analyze NVDA')

    server.threads = server.threads.map((thread) => ({ ...thread, title: 'NVIDIA Analysis' }))
    t.mock.timers.tick(2000)
    await h.flush()
    assert.equal(server.gets('/v1/chat/threads'), listReads + 2)
    assert.equal(header(), 'NVIDIA Analysis')
    assert.equal(activeRow(), 'NVIDIA Analysis')

    t.mock.timers.tick(3000)
    await h.flush()
    t.mock.timers.tick(5000)
    await h.flush()
    assert.equal(server.gets('/v1/chat/threads'), listReads + 2)
    assert.doesNotMatch(h.text(), UUID_PATTERN)
  } finally {
    await h.cleanup()
  }
})

test('switching threads mid-stream detaches the stream: it dispatches nothing and closes on its terminal event', async () => {
  const server = new FakeServer()
  server.threads = [
    { thread_id: 'T1', title: 'Chips', updated_at: '2026-05-06T00:00:00.000Z' },
    { thread_id: 'T2', title: 'Rates', updated_at: '2026-05-05T00:00:00.000Z' },
  ]
  server.history = (id) => ({
    body: { messages: id === 'T2' ? [chatMessage('T2', 't2-user', 'user', 'What did the Fed do?')] : [] },
  })
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    const source = FakeEventSource.instances[0]
    await streamAnswer(h, source)
    assert.equal(occurrences(h.text(), ANSWER), 1)

    const t2Link = h.query('a[href="/chat/T2"]') as HTMLAnchorElement
    await act(async () => t2Link.click())
    await h.flush()

    assert.equal(h.path(), '/chat/T2')
    assert.equal(source.closed, false)
    assert.equal(h.query('[data-role="user"]')?.textContent, 'What did the Fed do?')
    assert.equal(occurrences(h.text(), ANSWER), 0)

    const before = h.text()
    await act(async () => source.emit('block.delta', 6, { block_id: 'b1', delta: { segment: { type: 'text', text: ' late' } } }))
    await complete(h, source)
    assert.equal(h.text(), before)
    assert.equal(source.closed, true)
    assert.equal(server.gets('/v1/chat/threads/T1/messages'), 1)
  } finally {
    await h.cleanup()
  }
})

test('a failed reload keeps the streamed answer, and Reload hands it off', async () => {
  const server = new FakeServer()
  let failNext = false
  server.history = (id) => (failNext
    ? { status: 500, body: { error: 'history unavailable' } }
    : { body: { messages: server.posted.size === 0 ? [] : [server.postedUser(id), sealedAnswer(id)] } })
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    await streamAnswer(h, FakeEventSource.instances[0])
    failNext = true
    await complete(h, FakeEventSource.instances[0])

    assert.equal(occurrences(h.text(), ANSWER), 1)
    assert.match(h.text(), /Couldn't load the saved copy of this answer\./)
    assert.equal(h.query('[data-role="user"]')?.textContent, 'Analyze NVDA')
    assert.equal(h.button('Send').disabled, false)

    failNext = false
    await act(async () => h.button('Reload').click())
    await h.flush()

    assert.equal(server.gets('/v1/chat/threads/T1/messages'), 3)
    assert.equal(h.query('[data-testid="streaming-turn"]'), null)
    assert.equal(h.query('[data-role="assistant"]')?.textContent?.includes(ANSWER), true)
    assert.equal(occurrences(h.text(), ANSWER), 1)
  } finally {
    await h.cleanup()
  }
})

test('asking again while the answer is kept leaves that answer on screen above the new question', async () => {
  const server = new FakeServer()
  server.history = () => (server.posted.size === 0 ? { body: { messages: [] } } : { status: 500, body: { error: 'history unavailable' } })
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    await streamAnswer(h, FakeEventSource.instances[0])
    await complete(h, FakeEventSource.instances[0])
    await h.ask('Analyze AMD')

    assert.equal(occurrences(h.text(), ANSWER), 1)
    assert.match(h.text(), /Couldn't load the saved copy of this answer\./)
    assert.deepEqual(
      [...h.container.querySelectorAll('[data-testid="streaming-turn"]')].map((turn) => turn.getAttribute('data-turn-status')),
      ['kept', 'streaming'],
    )
    assert.equal(h.text().indexOf(ANSWER) < h.text().lastIndexOf('Analyze AMD'), true)
  } finally {
    await h.cleanup()
  }
})

test('a dropped stream shows Retry, which reopens the same run, and leaving chat closes it', async () => {
  const server = new FakeServer()
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    const first = FakeEventSource.instances[0]
    await streamAnswer(h, first)
    assert.equal(h.button('Send').disabled, true)

    await act(async () => first.onerror?.())
    await h.flush()
    assert.match(h.text(), /The analyst stream disconnected\./)
    assert.equal(occurrences(h.text(), ANSWER), 1)
    assert.equal(h.button('Send').disabled, false)

    await act(async () => h.button('Retry stream').click())
    await h.flush()
    assert.equal(FakeEventSource.instances.length, 2)
    const second = FakeEventSource.instances[1]
    assert.equal(second.params.get('run_id'), first.params.get('run_id'))
    assert.equal(second.params.get('turn_id'), first.params.get('turn_id'))
    assert.equal(first.closed, true)
    assert.doesNotMatch(h.text(), /The analyst stream disconnected\./)

    await h.unmount()
    assert.equal(second.closed, true)
  } finally {
    await h.cleanup()
  }
})

test('leaving chat while the thread is being created stays away, and the question still posts and starts its run', async () => {
  const server = new FakeServer()
  const created = deferred<void>()
  server.createReply = () => created.promise.then(() => ({ status: 201, body: server.createThread() }))
  const h = await renderChat('/chat', server)
  try {
    await h.ask('Analyze NVDA')
    await h.navigate('/home')
    assert.equal(h.path(), '/home')

    await act(async () => created.resolve())
    await h.flush()

    assert.equal(h.path(), '/home')
    assert.equal(h.text(), 'Home')
    assert.deepEqual(server.writes().map(([method, path]) => [method, path]), [
      ['POST', '/v1/chat/threads'],
      ['POST', '/v1/chat/threads/T1/messages'],
    ])
    assert.equal(FakeEventSource.instances.length, 1)
    const detached = FakeEventSource.instances[0]
    assert.match(detached.url, /^\/v1\/chat\/threads\/T1\/stream\?/)
    assert.equal(detached.closed, false)
    await act(async () => detached.emit('turn.completed', 1, { message_id: 'a1' }))
    assert.equal(detached.closed, true)
  } finally {
    await h.cleanup()
  }
})

const TWO_THREADS = [
  { thread_id: 'T1', title: 'Chips', updated_at: '2026-05-06T00:00:00.000Z' },
  { thread_id: 'T2', title: 'Rates', updated_at: '2026-05-05T00:00:00.000Z' },
]
const T2_QUESTION = chatMessage('T2', 't2-user', 'user', 'What did the Fed do?')
const STILL_ANSWERING = /The analyst is still answering this question\./

async function openThread(h: Harness, threadId: string) {
  await act(async () => (h.query(`a[href="/chat/${threadId}"]`) as HTMLAnchorElement).click())
  await h.flush()
}

const consecutive = (counts: number[]) => counts.filter((count, i) => i === 0 || count !== counts[i - 1])

test('returning to a thread whose question is still being saved blocks a second ask until its run settles and reloads', async () => {
  const server = new FakeServer()
  server.threads = TWO_THREADS
  const saved = deferred<void>()
  server.postReply = (message) => saved.promise.then(() => ({ status: 201, body: { message } }))
  let sealed = false
  server.history = (id) => ({
    body: { messages: id === 'T2' ? [T2_QUESTION] : sealed ? [server.postedUser('T1'), sealedAnswer('T1')] : [] },
  })
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    await openThread(h, 'T2')
    await openThread(h, 'T1')

    assert.equal(h.button('Send').disabled, true)
    assert.match(h.text(), STILL_ANSWERING)
    await h.ask('Analyze AMD')
    assert.equal(FakeEventSource.instances.length, 0)

    await act(async () => saved.resolve())
    await h.flush()
    await h.ask('Analyze AMD')

    assert.deepEqual(server.writes().map(([method, path]) => [method, path]), [['POST', '/v1/chat/threads/T1/messages']])
    assert.equal(FakeEventSource.instances.length, 1)
    const detached = FakeEventSource.instances[0]
    assert.match(detached.url, /^\/v1\/chat\/threads\/T1\/stream\?/)
    assert.equal(h.button('Send').disabled, true)
    assert.match(h.text(), STILL_ANSWERING)

    await streamAnswer(h, detached)
    assert.equal(occurrences(h.text(), ANSWER), 0)
    sealed = true
    await complete(h, detached)

    assert.equal(server.gets('/v1/chat/threads/T1/messages'), 3)
    assert.equal(occurrences(h.text(), ANSWER), 1)
    assert.equal(h.query('[data-role="assistant"]')?.textContent?.includes(ANSWER), true)
    assert.equal(h.query('[data-role="user"]')?.textContent, 'Analyze NVDA')
    assert.doesNotMatch(h.text(), STILL_ANSWERING)
    assert.equal(h.button('Send').disabled, false)
    assert.equal(server.writes().length, 1)
  } finally {
    await h.cleanup()
  }
})

test('returning to a thread mid-stream shows its saved answer once from history and opens no second stream', async () => {
  const server = new FakeServer()
  server.threads = TWO_THREADS
  server.history = (id) => ({
    body: { messages: id === 'T2' ? [T2_QUESTION] : server.posted.size === 0 ? [] : [server.postedUser('T1'), sealedAnswer('T1')] },
  })
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    const detached = FakeEventSource.instances[0]
    await streamAnswer(h, detached)
    await openThread(h, 'T2')
    const returned = h.frames.length
    await openThread(h, 'T1')

    assert.equal(FakeEventSource.instances.length, 1)
    assert.equal(h.button('Send').disabled, true)
    assert.match(h.text(), STILL_ANSWERING)

    await act(async () => detached.emit('block.delta', 6, { block_id: 'b1', delta: { segment: { type: 'text', text: ' late' } } }))
    await complete(h, detached)

    assert.deepEqual(consecutive(h.frames.slice(returned).map((frame) => occurrences(frame, ANSWER))), [0, 1])
    assert.equal(FakeEventSource.instances.length, 1)
    assert.doesNotMatch(h.text(), STILL_ANSWERING)
    assert.equal(h.button('Send').disabled, false)
  } finally {
    await h.cleanup()
  }
})

test('a run elsewhere whose stream drops while the user is back on its thread reloads history instead of offering Retry', async () => {
  const server = new FakeServer()
  server.threads = TWO_THREADS
  server.history = (id) => ({
    body: { messages: id === 'T2' ? [T2_QUESTION] : server.posted.size === 0 ? [] : [server.postedUser('T1')] },
  })
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    const detached = FakeEventSource.instances[0]
    await streamAnswer(h, detached)
    await openThread(h, 'T2')
    await openThread(h, 'T1')

    await act(async () => detached.onerror?.())
    await h.flush()

    assert.equal(server.gets('/v1/chat/threads/T1/messages'), 3)
    assert.doesNotMatch(h.text(), /The analyst stream disconnected\./)
    assert.equal([...h.container.querySelectorAll('button')].some((button) => button.textContent === 'Retry stream'), false)
    assert.doesNotMatch(h.text(), STILL_ANSWERING)
    assert.equal(h.query('[data-role="user"]')?.textContent, 'Analyze NVDA')
    assert.equal(h.button('Send').disabled, false)
    assert.equal(FakeEventSource.instances.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a draft typed while the first question is being sent survives the move to the new thread', async () => {
  const server = new FakeServer()
  const created = deferred<void>()
  server.createReply = () => created.promise.then(() => ({ status: 201, body: server.createThread() }))
  const h = await renderChat('/chat', server)
  try {
    await h.ask('Analyze NVDA')
    await h.type('Follow up')

    await act(async () => created.resolve())
    await h.flush()

    assert.equal(h.path(), '/chat/T1')
    assert.equal(h.container.querySelectorAll('textarea').length, 1)
    assert.equal((h.query('textarea') as HTMLTextAreaElement).value, 'Follow up')
  } finally {
    await h.cleanup()
  }
})

test('a failed title refresh keeps the sidebar row and the header name', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const server = new FakeServer()
  server.threads = [{ thread_id: 'T1', title: 'Chips', updated_at: '2026-05-06T00:00:00.000Z' }]
  server.history = (id) => ({ body: { messages: server.posted.size === 0 ? [] : [server.postedUser(id), sealedAnswer(id)] } })
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    await streamAnswer(h, FakeEventSource.instances[0])
    await complete(h, FakeEventSource.instances[0])
    const listReads = server.gets('/v1/chat/threads')

    server.listReply = () => ({ status: 502, body: { error: 'bad gateway' } })
    t.mock.timers.tick(0)
    await h.flush()

    assert.equal(server.gets('/v1/chat/threads'), listReads + 1)
    assert.equal(h.query('a[href="/chat/T1"] span')?.textContent, 'Chips')
    assert.equal(h.query('[data-testid="thread-name"]')?.textContent, 'Chips')
    assert.doesNotMatch(h.text(), /HTTP 502/)
  } finally {
    await h.cleanup()
  }
})

test('a failed first thread-list load shows its error', async () => {
  const server = new FakeServer()
  server.listReply = () => ({ status: 502, body: { error: 'bad gateway' } })
  const h = await renderChat('/chat', server)
  try {
    assert.match(h.query('nav[aria-label="Thread list"]')?.textContent ?? '', /HTTP 502/)
  } finally {
    await h.cleanup()
  }
})
