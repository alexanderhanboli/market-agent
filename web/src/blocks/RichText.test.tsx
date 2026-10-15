import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { EvidenceInspectorContext, type EvidenceInspectorContextValue } from '../evidence/evidenceInspectorContext.ts'
import type { EvidenceInspectionRef } from '../evidence/inspectionTypes.ts'
import { SnapshotManifestContext } from './snapshotManifestContext.ts'
import { RichText } from './RichText.tsx'
import type { RichTextBlock } from './types.ts'

function installDomGlobals(domWindow: Window): () => void {
  const globals = globalThis as unknown as {
    IS_REACT_ACT_ENVIRONMENT?: boolean
    document?: Document
    window?: Window
  }
  const hadActEnv = Object.prototype.hasOwnProperty.call(globals, 'IS_REACT_ACT_ENVIRONMENT')
  const hadDocument = Object.prototype.hasOwnProperty.call(globals, 'document')
  const hadWindow = Object.prototype.hasOwnProperty.call(globals, 'window')
  const previousActEnv = globals.IS_REACT_ACT_ENVIRONMENT
  const previousDocument = globals.document
  const previousWindow = globals.window

  globals.IS_REACT_ACT_ENVIRONMENT = true
  globals.document = domWindow.document
  globals.window = domWindow

  return () => {
    if (hadActEnv) globals.IS_REACT_ACT_ENVIRONMENT = previousActEnv
    else delete globals.IS_REACT_ACT_ENVIRONMENT
    if (hadDocument) globals.document = previousDocument
    else delete globals.document
    if (hadWindow) globals.window = previousWindow
    else delete globals.window
  }
}

const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111'

async function renderDocument(
  block: RichTextBlock,
  inspector: EvidenceInspectorContextValue | null = null,
): Promise<Document> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const restoreGlobals = installDomGlobals(dom.window as unknown as Window)
  try {
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(async () => {
      root.render(
        <EvidenceInspectorContext.Provider value={inspector}>
          <SnapshotManifestContext.Provider value={null}>
            <RichText block={block} />
          </SnapshotManifestContext.Provider>
        </EvidenceInspectorContext.Provider>,
      )
    })
    const snapshot = new JSDOM(dom.window.document.documentElement.outerHTML).window.document
    await act(async () => root.unmount())
    return snapshot
  } finally {
    restoreGlobals()
  }
}

function richTextBlock(id: string, segments: RichTextBlock['segments']): RichTextBlock {
  return {
    id,
    kind: 'rich_text',
    snapshot_id: SNAPSHOT_ID,
    data_ref: { kind: 'rich_text', id },
    source_refs: [],
    as_of: '2026-06-01T00:00:00.000Z',
    segments,
  }
}

function refAttrs(doc: Document): string[][] {
  return [...doc.querySelectorAll('[data-ref-id]')].map((el) => [
    el.getAttribute('data-testid') ?? '',
    el.getAttribute('data-ref-kind') ?? '',
    el.getAttribute('data-ref-id') ?? '',
    el.getAttribute('data-ref-state') ?? '',
    el.textContent ?? '',
  ])
}

const FACT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FACT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const MARKDOWN_TABLE = '| M | FY25 |\n| --- | --- |\n| Rev | $12B |'

const block: RichTextBlock = {
  id: 'rich-text-md-1',
  kind: 'rich_text',
  snapshot_id: SNAPSHOT_ID,
  data_ref: { kind: 'rich_text', id: 'rich-text-md-1' },
  source_refs: [],
  as_of: '2026-06-01T00:00:00.000Z',
  segments: [{ type: 'text', text: MARKDOWN_TABLE }],
}

test('RichText renders markdown table for text segments', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const restoreGlobals = installDomGlobals(dom.window as unknown as Window)
  try {
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(async () => {
      root.render(
        <SnapshotManifestContext.Provider value={null}>
          <RichText block={block} />
        </SnapshotManifestContext.Provider>,
      )
    })

    const html = dom.window.document.getElementById('root')!.innerHTML
    assert.match(html, /<table[\s>]/, 'should contain a <table> element')
    assert.match(html, /<td[^>]*>\$12B<\/td>/, 'should contain <td>$12B</td>')

    await act(async () => root.unmount())
  } finally {
    restoreGlobals()
  }
})

const interleavedBlock: RichTextBlock = {
  id: 'rich-text-inline-1',
  kind: 'rich_text',
  snapshot_id: SNAPSHOT_ID,
  data_ref: { kind: 'rich_text', id: 'rich-text-inline-1' },
  source_refs: [],
  as_of: '2026-06-01T00:00:00.000Z',
  segments: [
    { type: 'text', text: 'Revenue grew ' },
    { type: 'ref', ref_kind: 'fact', ref_id: '22222222-2222-4222-8222-222222222222' },
    { type: 'text', text: ' last quarter.' },
  ],
}

test('RichText keeps a ref in the same paragraph as the text around it', async () => {
  const doc = await renderDocument(interleavedBlock)
  const paragraphs = [...doc.querySelectorAll('p')]
  assert.deepEqual(paragraphs.map((p) => p.textContent), ['Revenue grew [fact:22222222] last quarter.'])
  assert.equal(paragraphs[0].querySelector('[data-ref-id]')?.getAttribute('data-ref-id'), '22222222-2222-4222-8222-222222222222')
})

const tonedBlock: RichTextBlock = {
  id: 'rich-text-tone-1',
  kind: 'rich_text',
  snapshot_id: SNAPSHOT_ID,
  data_ref: { kind: 'rich_text', id: 'rich-text-tone-1' },
  source_refs: [],
  as_of: '2026-06-01T00:00:00.000Z',
  segments: [
    { type: 'text', text: 'Data Center revenue grew ' },
    { type: 'text', text: '+127% YoY', tone: 'positive' },
    { type: 'text', text: ' last quarter' },
  ],
}

test('RichText styles toned text segments (inline colored deltas)', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const restoreGlobals = installDomGlobals(dom.window as unknown as Window)
  try {
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(async () => {
      root.render(
        <SnapshotManifestContext.Provider value={null}>
          <RichText block={tonedBlock} />
        </SnapshotManifestContext.Provider>,
      )
    })

    const html = dom.window.document.getElementById('root')!.innerHTML
    assert.match(html, /data-tone="positive"/, 'toned run carries data-tone')
    assert.match(html, /text-positive/, 'toned run is colored via text-positive')
    assert.match(html, /\+127% YoY/, 'toned text content present')

    await act(async () => root.unmount())
  } finally {
    restoreGlobals()
  }
})

const neutralMarkdownBlock: RichTextBlock = {
  id: 'rich-text-neutral-md-1',
  kind: 'rich_text',
  snapshot_id: SNAPSHOT_ID,
  data_ref: { kind: 'rich_text', id: 'rich-text-neutral-md-1' },
  source_refs: [],
  as_of: '2026-06-01T00:00:00.000Z',
  segments: [{ type: 'text', text: MARKDOWN_TABLE, tone: 'neutral' }],
}

test('neutral tone keeps the single-segment Markdown fast-path', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const restoreGlobals = installDomGlobals(dom.window as unknown as Window)
  try {
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(async () => {
      root.render(
        <SnapshotManifestContext.Provider value={null}>
          <RichText block={neutralMarkdownBlock} />
        </SnapshotManifestContext.Provider>,
      )
    })

    const html = dom.window.document.getElementById('root')!.innerHTML
    assert.match(html, /<table[\s>]/, 'neutral tone must not break Markdown table rendering')

    await act(async () => root.unmount())
  } finally {
    restoreGlobals()
  }
})

test('a cited answer keeps its Markdown: bold, a bullet list, and both fact chips in order', async () => {
  const doc = await renderDocument(richTextBlock('rt-answer', [
    { type: 'text', text: '**Takeaway:** demand held up.\n\n- Revenue: ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$12.6B' },
    { type: 'text', text: '\n- Gross margin: ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_B, format: '71.2%' },
    { type: 'text', text: '\n' },
  ]))
  assert.deepEqual([...doc.querySelectorAll('strong')].map((el) => el.textContent), ['Takeaway:'])
  assert.deepEqual([...doc.querySelectorAll('li')].map((el) => el.textContent), ['Revenue: $12.6B', 'Gross margin: 71.2%'])
  assert.deepEqual(refAttrs(doc), [
    ['block-rich-text-rt-answer-ref-1', 'fact', FACT_A, 'placeholder', '$12.6B'],
    ['block-rich-text-rt-answer-ref-3', 'fact', FACT_B, 'placeholder', '71.2%'],
  ])
  assert.deepEqual([...doc.querySelectorAll('[data-ref-id]')].map((el) => el.closest('li') !== null), [true, true])
  assert.doesNotMatch(doc.body.textContent ?? '', /\*\*/)
})

test('a ref sits inside a GFM table cell and its format text never reaches the parser', async () => {
  const doc = await renderDocument(richTextBlock('rt-table', [
    { type: 'text', text: '| Metric | FY25 |\n| --- | --- |\n| Revenue | ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '**$1|2**_x_' },
    { type: 'text', text: ' |' },
  ]))
  assert.deepEqual([...doc.querySelectorAll('td')].map((el) => el.textContent), ['Revenue', '**$1|2**_x_'])
  assert.equal(doc.querySelector('td [data-ref-id]')?.getAttribute('data-ref-id'), FACT_A)
  assert.equal(doc.querySelectorAll('td strong, td em').length, 0)
})

test('text that imitates a ref chip renders as text or a plain link, never as a chip', async () => {
  const doc = await renderDocument(richTextBlock('rt-forge', [
    { type: 'text', text: 'See [forged](#ma-ref-0) and <md-embed index="0"></md-embed> for ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$12.6B' },
    { type: 'text', text: '.' },
  ]))
  assert.deepEqual(refAttrs(doc), [['block-rich-text-rt-forge-ref-1', 'fact', FACT_A, 'placeholder', '$12.6B']])
  assert.deepEqual([...doc.querySelectorAll('a')].map((el) => [el.getAttribute('href'), el.textContent]), [['#ma-ref-0', 'forged']])
})

test('a normal Markdown link in cited text still renders as an external link', async () => {
  const doc = await renderDocument(richTextBlock('rt-link', [
    { type: 'text', text: 'Per the [10-K](https://www.sec.gov/x), revenue was ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$12.6B' },
  ]))
  const link = doc.querySelector('a')
  assert.deepEqual(
    [link?.getAttribute('href'), link?.getAttribute('target'), link?.textContent],
    ['https://www.sec.gov/x', '_blank', '10-K'],
  )
  assert.equal(doc.querySelector('p')?.textContent, 'Per the 10-K, revenue was $12.6B')
})

test('text that hides a ref inside an HTML comment cannot remove the chip', async () => {
  const doc = await renderDocument(richTextBlock('rt-hide', [
    { type: 'text', text: 'Revenue <!-- ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$12.6B' },
    { type: 'text', text: ' --> grew.' },
  ]))
  assert.deepEqual(refAttrs(doc), [['block-rich-text-rt-hide-ref-1', 'fact', FACT_A, 'placeholder', '$12.6B']])
})

test('an HTML comment in the text keeps every chip in its place and leaks no placeholder', async () => {
  const doc = await renderDocument(richTextBlock('rt-order', [
    { type: 'text', text: 'Revenue <!-- ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$12.6B' },
    { type: 'text', text: ' -->; margin ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_B, format: '55.8%' },
  ]))
  assert.deepEqual(refAttrs(doc).map((attrs) => attrs[2]), [FACT_A, FACT_B])
  assert.doesNotMatch(doc.body.textContent ?? '', /mdembed/)
})

test('a link written around a chip is unwrapped: no chip sits inside a link', async () => {
  const doc = await renderDocument(richTextBlock('rt-link', [
    { type: 'text', text: 'See [' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$12.6B' },
    { type: 'text', text: '](https://example.org) and https://www.sec.gov ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_B, format: '55.8%' },
  ]))
  assert.deepEqual(refAttrs(doc).map((attrs) => attrs[2]), [FACT_A, FACT_B])
  assert.equal(doc.querySelectorAll('a [data-ref-kind]').length, 0)
})

test('a link whose label holds a toned run keeps its URL: only chips unwrap a link', async () => {
  const doc = await renderDocument(richTextBlock('rt-tone-link', [
    { type: 'text', text: '[Change ' },
    { type: 'text', text: '+12%', tone: 'positive' },
    { type: 'text', text: '](https://example.com) for ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$12.6B' },
  ]))
  const link = doc.querySelector('a')
  assert.deepEqual([link?.getAttribute('href'), link?.textContent], ['https://example.com', 'Change +12%'])
  assert.equal(doc.querySelectorAll('a [data-ref-kind]').length, 0)
})

test('a chip the text swallows into a link URL renders the block in order, text unparsed', async () => {
  const doc = await renderDocument(richTextBlock('rt-url', [
    { type: 'text', text: '**Revenue** [x](https://example.org/' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$12.6B' },
    { type: 'text', text: ') then ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_B, format: '55.8%' },
  ]))
  assert.deepEqual(refAttrs(doc).map((attrs) => attrs[2]), [FACT_A, FACT_B])
  assert.equal(doc.querySelector('p')?.textContent, '**Revenue** [x](https://example.org/$12.6B) then 55.8%')
})

test('a toned run inside cited Markdown keeps its tone and is not parsed as Markdown', async () => {
  const doc = await renderDocument(richTextBlock('rt-tone', [
    { type: 'text', text: '**Data Center** grew ' },
    { type: 'text', text: '+127% *YoY*', tone: 'positive' },
    { type: 'text', text: ' to ' },
    { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$30.8B' },
  ]))
  const toned = doc.querySelector('[data-tone]')
  assert.deepEqual(
    [toned?.getAttribute('data-tone'), toned?.getAttribute('class'), toned?.textContent],
    ['positive', 'font-medium text-positive', '+127% *YoY*'],
  )
  assert.equal(doc.querySelector('p')?.textContent, 'Data Center grew +127% *YoY* to $30.8B')
})

test('a chip inside Markdown opens the evidence inspector for its ref', async () => {
  const opened: Array<{ snapshotId: string; ref: EvidenceInspectionRef }> = []
  const inspector: EvidenceInspectorContextValue = {
    openInspection(input) { opened.push(input) },
    openBlockInspection() {},
    closeInspection() {},
  }
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const restoreGlobals = installDomGlobals(dom.window as unknown as Window)
  try {
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(async () => {
      root.render(
        <EvidenceInspectorContext.Provider value={inspector}>
          <RichText block={richTextBlock('rt-click', [
            { type: 'text', text: '**Revenue:** ' },
            { type: 'ref', ref_kind: 'fact', ref_id: FACT_A, format: '$12.6B' },
          ])} />
        </EvidenceInspectorContext.Provider>,
      )
    })
    const chip = dom.window.document.querySelector('[data-testid="block-rich-text-rt-click-ref-1"]') as HTMLElement
    assert.equal(chip.tagName, 'BUTTON')
    await act(async () => chip.click())
    assert.deepEqual(opened, [{ snapshotId: SNAPSHOT_ID, ref: { kind: 'fact', id: FACT_A } }])
    await act(async () => root.unmount())
  } finally {
    restoreGlobals()
  }
})
