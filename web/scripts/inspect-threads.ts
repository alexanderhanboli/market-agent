// Opens chat threads in a real browser and reports what the user sees in each
// answer's prose: sealed ref chips against numbers left as plain text. Saves a
// full-page screenshot per thread and summary.json. It reports; it never fails
// on plain numbers.
//
//   node --experimental-strip-types scripts/inspect-threads.ts [--out dir] [--base URL] <eval report .md | thread URL | thread id>...
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { chromium } from '@playwright/test'

type ThreadReport = {
  thread: string
  // False when the walk stopped before the end of the list: the counts are partial.
  complete: boolean
  url: string
  screenshot: string
  answers: number
  fact_chips: number
  claim_chips: number
  // In the model's narrative, the message's first rich text (local-runtime.ts
  // puts the answer's own blocks before its fact blocks): what answer-lab counts.
  plain_numbers: number
  plain_samples: string[]
  // In any further rich text (a gap note, a filed explanation), written by code.
  note_numbers: number
  console_errors: string[]
  // Responses that failed, with their URLs: which service a console 503 came from.
  failed_requests: string[]
}

const ANSWER_TIMEOUT_MS = 30_000

// Thread URLs from the arguments: an eval report's Thread: lines, a URL, or an id.
function threadUrls(args: ReadonlyArray<string>, base: string): string[] {
  return args.flatMap((arg) => {
    if (arg.endsWith('.md')) return [...readFileSync(arg, 'utf8').matchAll(/^Thread: (\S+)$/gm)].map((match) => match[1]!)
    return [/^https?:\/\//.test(arg) ? arg : `${base}/chat/${arg}`]
  })
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', default: fileURLToPath(new URL(`../../.dev/inspect/${new Date().toISOString().slice(0, 19).replace(/:/g, '')}`, import.meta.url)) },
      base: { type: 'string', default: 'http://127.0.0.1:5173' },
    },
  })
  const urls = threadUrls(positionals, values.base)
  if (urls.length === 0) {
    console.error('usage: inspect-threads.ts [--out dir] [--base URL] <eval report .md | thread URL | thread id>...')
    return 2
  }
  mkdirSync(values.out, { recursive: true })
  const browser = await chromium.launch()
  const reports: ThreadReport[] = []
  try {
    for (const url of urls) {
      const thread = new URL(url).pathname.split('/').at(-1)!
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      const consoleErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      page.on('pageerror', (error) => consoleErrors.push(error.message))
      const failedRequests: string[] = []
      page.on('response', (response) => {
        if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`)
      })
      await page.goto(url)
      const answered = await page.locator('[data-role="assistant"]').first().waitFor({ timeout: ANSWER_TIMEOUT_MS }).then(() => true, () => false)
      // Chips resolve once the snapshot manifest loads.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
      // The message list mounts only the messages near its scroll position, so
      // it is walked top to bottom and each assistant message counted once, by id.
      let complete = !answered
      const seen = new Map<string, { fact_chips: number; claim_chips: number; plain: string[]; notes: number }>()
      const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
      const scrollTo = (top: number) => page.evaluate((top) => {
        const list = document.querySelector('[data-inspect-scroller]')
        if (!list) return true
        list.scrollTop = top
        return list.scrollTop + list.clientHeight >= list.scrollHeight - 1
      }, top)
      if (answered) {
        // The nearest ancestor of the messages that scrolls them.
        await page.evaluate(() => {
          let element = document.querySelector('[data-message-id]')?.parentElement ?? null
          while (element && !(/auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight)) element = element.parentElement
          element?.setAttribute('data-inspect-scroller', '')
        })
        const step = await page.evaluate(() => Math.max(100, Math.floor((document.querySelector('[data-inspect-scroller]')?.clientHeight ?? 0) / 2)))
        for (let top = 0, pass = 0; pass < 500; top += step, pass++) {
          const atEnd = await scrollTo(top)
          await frames()
          for (const message of await page.locator('[data-role="assistant"][data-message-id]').evaluateAll((items) => items.map((item) => {
            const [narrative, ...notes] = [...item.querySelectorAll('[data-block-kind="rich_text"]')]
            const numbers = (block: Element | undefined) => {
              const found: string[] = []
              if (!block) return found
              const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (node.parentElement?.closest('[data-ref-kind]')) continue
                found.push(...(node.textContent?.match(/\d+(?:[.,]\d+)*/g) ?? []))
              }
              return found
            }
            return {
              id: item.getAttribute('data-message-id')!,
              fact_chips: narrative?.querySelectorAll('[data-ref-kind="fact"]').length ?? 0,
              claim_chips: narrative?.querySelectorAll('[data-ref-kind="claim"]').length ?? 0,
              plain: numbers(narrative),
              notes: notes.reduce((sum, note) => sum + numbers(note).length, 0),
            }
          }))) {
            seen.set(message.id, message)
          }
          if (atEnd) {
            complete = true
            break
          }
        }
      }
      const counts = [...seen.values()]
      // The picture only: the app scrolls inside its shell, so a viewport as tall as
      // the list shows most of the thread; the counts above do not depend on it.
      const extra = await page.evaluate(() => {
        const list = document.querySelector('[data-inspect-scroller]')
        if (!list) return 0
        list.scrollTop = 0
        return list.scrollHeight - list.clientHeight
      })
      await page.setViewportSize({ width: 1280, height: Math.min(900 + extra, 16_000) })
      await frames()
      const screenshot = join(values.out, `${thread}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      reports.push({
        thread,
        complete,
        url,
        screenshot,
        answers: counts.length,
        fact_chips: counts.reduce((sum, message) => sum + message.fact_chips, 0),
        claim_chips: counts.reduce((sum, message) => sum + message.claim_chips, 0),
        plain_numbers: counts.reduce((sum, message) => sum + message.plain.length, 0),
        plain_samples: counts.flatMap((message) => message.plain).slice(0, 12),
        note_numbers: counts.reduce((sum, message) => sum + message.notes, 0),
        console_errors: consoleErrors,
        failed_requests: failedRequests,
      })
      await page.close()
    }
  } finally {
    await browser.close()
  }
  writeFileSync(join(values.out, 'summary.json'), `${JSON.stringify(reports, null, 2)}\n`)
  const rows = [
    ['thread', 'complete', 'answers', 'fact chips', 'claim chips', 'plain #', 'note #', 'console errors'],
    ...reports.map((report) => [
      report.thread,
      report.complete ? 'yes' : 'NO',
      String(report.answers),
      String(report.fact_chips),
      String(report.claim_chips),
      String(report.plain_numbers),
      String(report.note_numbers),
      String(report.console_errors.length),
    ]),
  ]
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)))
  console.log(rows.map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ')).join('\n'))
  console.log(`\n${join(values.out, 'summary.json')}`)
  return 0
}

process.exitCode = await main(process.argv.slice(2))
