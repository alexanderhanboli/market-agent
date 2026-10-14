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
  url: string
  screenshot: string
  answers: number
  fact_chips: number
  claim_chips: number
  plain_numbers: number
  plain_samples: string[]
  console_errors: string[]
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
      await page.goto(url)
      const prose = page.locator('[data-role="assistant"] [data-block-kind="rich_text"]')
      const answered = await prose.first().waitFor({ timeout: ANSWER_TIMEOUT_MS }).then(() => true, () => false)
      // Chips resolve once the snapshot manifest loads.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
      const counts = answered
        ? await prose.evaluateAll((blocks) => {
          const plain: string[] = []
          for (const block of blocks) {
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.parentElement?.closest('[data-ref-kind]')) continue
              plain.push(...(node.textContent?.match(/\d+(?:[.,]\d+)*/g) ?? []))
            }
          }
          return {
            fact_chips: blocks.reduce((sum, block) => sum + block.querySelectorAll('[data-ref-kind="fact"]').length, 0),
            claim_chips: blocks.reduce((sum, block) => sum + block.querySelectorAll('[data-ref-kind="claim"]').length, 0),
            plain,
          }
        })
        : { fact_chips: 0, claim_chips: 0, plain: [] }
      // The thread scrolls inside the app shell, not the page: a viewport as tall
      // as its content makes the full-page screenshot hold the whole thread.
      const height = await page.evaluate(() => Math.max(...[...document.querySelectorAll('*')].map((element) => element.scrollHeight)))
      await page.setViewportSize({ width: 1280, height: Math.min(height + 200, 16_000) })
      const screenshot = join(values.out, `${thread}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      reports.push({
        thread,
        url,
        screenshot,
        answers: await page.locator('[data-role="assistant"]').count(),
        fact_chips: counts.fact_chips,
        claim_chips: counts.claim_chips,
        plain_numbers: counts.plain.length,
        plain_samples: counts.plain.slice(0, 12),
        console_errors: consoleErrors,
      })
      await page.close()
    }
  } finally {
    await browser.close()
  }
  writeFileSync(join(values.out, 'summary.json'), `${JSON.stringify(reports, null, 2)}\n`)
  const rows = [
    ['thread', 'answers', 'fact chips', 'claim chips', 'plain #', 'console errors'],
    ...reports.map((report) => [
      report.thread,
      String(report.answers),
      String(report.fact_chips),
      String(report.claim_chips),
      String(report.plain_numbers),
      String(report.console_errors.length),
    ]),
  ]
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)))
  console.log(rows.map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ')).join('\n'))
  console.log(`\n${join(values.out, 'summary.json')}`)
  return 0
}

process.exitCode = await main(process.argv.slice(2))
