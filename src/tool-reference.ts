/**
 * The tool reference (docs/TOOLS.md), rendered from the same definitions the MCP server registers (`buildToolList`), so the
 * published reference cannot drift from the code. A test regenerates it and fails when docs/TOOLS.md is stale; the README's tool
 * table is checked against the same list.
 */

interface Schema {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  oneOf?: Schema[]
  anyOf?: Schema[]
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema?: Schema
}

/** A compact type for one input: `string`, `"whole" | "base"`, `string[]`, `object[]`, `object`. */
function describeType(schema: Schema | undefined): string {
  if (!schema) return 'any'
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  const alternatives = schema.oneOf ?? schema.anyOf
  if (alternatives && alternatives.length > 0) return alternatives.map(describeType).join(' | ')
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type
  if (type === 'array') return `${describeType(schema.items)}[]`
  return type ?? 'any'
}

/**
 * Text outside a code span with `<` in it (a placeholder such as `<stateDir>`) is taken for an HTML tag by GitHub and disappears, so it
 * is written as `&lt;`. Inside a code span it is left alone: there it shows as written.
 */
export function escapeMarkup(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, '&lt;')))
    .join('')
}

/** Table cells cannot hold a line break or an unescaped pipe. */
function cell(text: string): string {
  return escapeMarkup(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

/**
 * The first sentence of a description, for the list at the top. A full stop after "e.g." or "i.e." does not end a sentence, and a
 * very short first sentence ("LAST RESORT.") is joined with the next one so the summary says something.
 */
export function summarise(description: string): string {
  const sentences = description.trim().split(/(?<=[.!?])\s+(?=[A-Z`"(])/)
  const ends = (s: string) => /\b(e\.g|i\.e|vs|etc)\.$/i.test(s)
  let summary = sentences[0] ?? description
  let i = 1
  while ((ends(summary) || summary.length < 25) && i < sentences.length) summary += ' ' + sentences[i++]
  return summary
}

function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

/** How deep a nested input is followed; the schemas here go two levels at most. */
const MAX_DEPTH = 3

/**
 * One row for each input and, under it, one for each field of a nested object (`quote.asset`), or of the objects in a list
 * (`attributes[].attributeName`). A nested field is "required" only within its parent, and the Required column says so.
 */
function inputRows(schema: Schema, prefix: string, depth: number, parentRequired: boolean): string[] {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const rows: string[] = []
  for (const [name, p] of Object.entries(properties)) {
    const path = prefix + name
    const isRequired = required.has(name)
    const requiredCell = isRequired ? (parentRequired ? 'yes' : 'yes, within its parent') : 'no'
    rows.push(`| \`${path}\` | ${cell(describeType(p))} | ${requiredCell} | ${cell(p.description ?? '')} |`)
    if (depth >= MAX_DEPTH) continue
    if (p.properties) rows.push(...inputRows(p, `${path}.`, depth + 1, false))
    else if (p.type === 'array' && p.items?.properties) rows.push(...inputRows(p.items, `${path}[].`, depth + 1, false))
  }
  return rows
}

function renderInputs(schema: Schema | undefined): string[] {
  if (Object.keys(schema?.properties ?? {}).length === 0) return ['**Input:** none.', '']
  return ['| Input | Type | Required | Description |', '|---|---|---|---|', ...inputRows(schema as Schema, '', 1, true), '']
}

/** The reference as Markdown: a list of every tool, then one section per tool with its full description and inputs. */
export function renderToolReference(tools: ToolDefinition[]): string {
  const lines: string[] = [
    '# Tool reference',
    '',
    '<!-- Generated from the tool definitions in `src/index.ts` (`buildToolList`) by `npm run docs:tools`. Do not edit by hand: a test fails when this file is stale. -->',
    '',
    `The wallet registers **${tools.length} tools**. The description of each is the text an agent reads, shown here in full; the inputs are the JSON Schema each tool declares, with the fields of a nested object on rows of their own (\`parent.child\`, or \`list[].field\` for the objects in a list).`,
    '',
    '| Tool | Summary |',
    '|---|---|',
  ]
  for (const t of tools) {
    const first = summarise(t.description)
    lines.push(`| [\`${t.name}\`](#${anchor(t.name)}) | ${cell(first)} |`)
  }
  lines.push('')
  for (const t of tools) {
    lines.push(`## ${t.name}`, '', escapeMarkup(t.description.trim()), '', ...renderInputs(t.inputSchema))
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** The names of the tools the README's tool table lists: the first backticked cell of each row under "## Tools". */
export function readmeToolNames(readme: string): string[] {
  const start = readme.indexOf('\n## Tools')
  if (start === -1) return []
  const rest = readme.slice(start + 1)
  const end = rest.indexOf('\n## ', 3)
  const section = end === -1 ? rest : rest.slice(0, end)
  const names: string[] = []
  for (const line of section.split(/\r?\n/)) {
    const m = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|/.exec(line)
    if (m) names.push(m[1])
  }
  return names
}
