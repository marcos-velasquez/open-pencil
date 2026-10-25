import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_ENTRY } from '#cli-tests/helpers/paths'

import { getTextMeasurer } from '@open-pencil/core/layout'
import { prepareGraphFonts } from '@open-pencil/core/text'

import { loadDocument, measureTextHeadlessly } from '#cli/headless'

setDefaultTimeout(60_000)

async function cli(args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: await proc.exited }
}

describe('convert CLI', () => {
  test('saves a .pen document with its text measured in its own fonts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-pencil-convert-'))
    const source = join(dir, 'tag.pen')
    const output = join(dir, 'tag.fig')
    await Bun.write(
      source,
      JSON.stringify({
        version: '2.21',
        children: [
          {
            id: 'tag',
            type: 'frame',
            layout: 'horizontal',
            padding: [4, 10],
            children: [
              {
                id: 'label',
                type: 'text',
                content: '1 lote propuesto',
                fontFamily: 'Inter',
                fontSize: 12,
                fontWeight: '600',
                fill: '#111111'
              }
            ]
          }
        ]
      })
    )
    expect((await cli(['convert', source, '-o', output])).exitCode).toBe(0)

    const graph = await loadDocument(output)
    const label = [...graph.getAllNodes()].find((node) => node.type === 'TEXT')
    if (!label) throw new Error('Expected the label')
    await measureTextHeadlessly()
    await prepareGraphFonts(
      graph,
      graph.getPages(true).map((page) => page.id)
    )
    const measured = getTextMeasurer()?.(label)
    if (!measured) throw new Error('Expected the label measured in its font')
    expect(label.width).toBeCloseTo(measured.width, 0)
    expect(graph.getNode(label.parentId ?? '')?.width).toBeCloseTo(measured.width + 20, 0)
  })
})
