import { createContext, useContext, useState, type ReactElement } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, ElementContent, Root, RootContent } from 'hast'

// Markdown source: text runs are Markdown, elements are embedded inline exactly
// where they sit between runs and never pass through the parser.
type MarkdownSource = string | ReadonlyArray<string | ReactElement>

const EMBED_TAG = 'md-embed'

const EmbedsContext = createContext<ReadonlyArray<ReactElement>>([])

function Embed({ node }: ExtraProps): ReactElement | null {
  const embeds = useContext(EmbedsContext)
  return embeds[Number(node?.properties.index)] ?? null
}

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-semibold text-fg">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-sm font-semibold text-fg">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted">{children}</h3>,
  p: ({ children }) => <p className="my-2">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  // An analyst's unverified hypothesis (#261), set apart for the reader to check.
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-line pl-3 italic text-muted">{children}</blockquote>,
  a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-accent underline">{children}</a>,
  // react-markdown v9 no longer passes an `inline` flag: fenced blocks
  // arrive here too (wrapped by `pre`, carrying a `language-*` class).
  // Only inline code gets the rounded/background pill; fenced code keeps
  // its class and inherits the `pre` block styling.
  code: ({ children, className }) =>
    className
      ? <code className={className}>{children}</code>
      : <code className="rounded bg-surface-2 px-1 py-0.5 text-[0.85em]">{children}</code>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-md bg-surface-2 p-3 text-xs">{children}</pre>,
  table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-xs">{children}</table></div>,
  thead: ({ children }) => <thead className="bg-surface-2">{children}</thead>,
  th: ({ children }) => <th className="border border-line px-2 py-1 text-right first:text-left">{children}</th>,
  td: ({ children }) => <td className="num border border-line px-2 py-1 text-right first:text-left">{children}</td>,
  ...({ [EMBED_TAG]: Embed } as Components),
}

// A random per-mount token, so text runs (model-written) cannot spell an
// embed's placeholder and forge or move one.
function newPlaceholderToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `mdembed${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}i`
}

function embedNode(index: number): Element {
  return { type: 'element', tagName: EMBED_TAG, properties: { index }, children: [] }
}

function replacePlaceholders(parent: Root | Element, pattern: RegExp, placed: Set<number>): void {
  const children: Array<RootContent> = []
  for (const child of parent.children) {
    if (child.type === 'element') replacePlaceholders(child, pattern, placed)
    if (child.type !== 'text') {
      children.push(child)
      continue
    }
    child.value.split(pattern).forEach((piece, i) => {
      if (i % 2 === 1) {
        placed.add(Number(piece))
        children.push(embedNode(Number(piece)))
      } else if (piece !== '') {
        children.push({ type: 'text', value: piece })
      }
    })
  }
  parent.children = children as Array<ElementContent>
}

// Swaps each placeholder left in a text node for its embed. A placeholder the
// text swallowed (an HTML comment, a link URL) still renders, after the prose.
function rehypeEmbeds(token: string, count: number) {
  const pattern = new RegExp(`${token}(\\d+)x`)
  return () => (tree: Root) => {
    const placed = new Set<number>()
    replacePlaceholders(tree, pattern, placed)
    const missing = Array.from({ length: count }, (_, i) => i).filter((i) => !placed.has(i))
    if (missing.length > 0) {
      tree.children.push({ type: 'element', tagName: 'p', properties: {}, children: missing.map(embedNode) })
    }
  }
}

// Themed GFM renderer for analyst answers. Block-level output (tables, headings)
// means the caller must render this inside a <div>, never a <p>.
export function Markdown({ text }: { text: MarkdownSource }): ReactElement {
  const [token] = useState(newPlaceholderToken)
  const embeds: ReactElement[] = []
  const source = typeof text === 'string'
    ? text
    : text.map((part) => (typeof part === 'string' ? part : `${token}${embeds.push(part) - 1}x`)).join('')
  return (
    <div className="text-sm leading-6 text-fg-soft [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <EmbedsContext.Provider value={embeds}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={embeds.length > 0 ? [rehypeEmbeds(token, embeds.length)] : []}
          components={COMPONENTS}
        >
          {source}
        </ReactMarkdown>
      </EmbedsContext.Provider>
    </div>
  )
}
