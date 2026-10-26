import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_ENTRY } from '#cli-tests/helpers/paths'
import * as v from 'valibot'

import { exportFigFile, parseFigFile } from '@open-pencil/core/io/formats/fig'
import { createLibraryRevision, materializeLibraryAsset } from '@open-pencil/core/library'
import { initCodec } from '@open-pencil/kiwi/fig/codec'
import { SceneGraph } from '@open-pencil/scene-graph'
import { recordInstanceOverride } from '@open-pencil/scene-graph/instances'
import type { Color } from '@open-pencil/scene-graph/primitives'

setDefaultTimeout(60_000)

async function cli(args: string[], stdin?: string) {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin ? Buffer.from(stdin) : undefined
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: await proc.exited }
}

function library(width: number, label: string): SceneGraph {
  const graph = new SceneGraph()
  const button = graph.createNode('COMPONENT', graph.getPages()[0].id, {
    name: 'Button',
    componentKey: 'button',
    width,
    height: 32
  })
  graph.createNode('TEXT', button.id, { name: 'Label', text: label })
  return graph
}

async function read(file: string): Promise<SceneGraph> {
  const bytes = await readFile(file)
  return parseFigFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

const resultSchema = v.object({
  used: v.boolean(),
  current: v.boolean(),
  updatedDefinitions: v.array(v.string()),
  updatedInstances: v.array(v.string()),
  removedDefinitions: v.number()
})

describe('libraries update CLI', () => {
  test("brings a document's library components to the new revision, keeping their overrides", async () => {
    await initCodec()
    const dir = await mkdtemp(join(tmpdir(), 'open-pencil-libraries-update-'))
    const source = join(dir, 'library.fig')
    const document = join(dir, 'document.fig')

    const consumer = new SceneGraph()
    const revision = await createLibraryRevision({
      libraryId: 'ds',
      name: 'DS',
      graph: library(80, 'Old')
    })
    const { componentId } = materializeLibraryAsset(consumer, revision, 'button')
    const instance = consumer.createInstance(componentId, consumer.getPages()[0].id, {
      name: 'Edited'
    })
    const label = instance ? consumer.getChildren(instance.id)[0] : undefined
    if (!label) throw new Error('Expected the label copy')
    consumer.updateNode(label.id, { text: 'Hello' })
    recordInstanceOverride(consumer, label.id, ['text'])
    await Bun.write(document, await exportFigFile(consumer))
    await Bun.write(source, await exportFigFile(library(120, 'New')))

    const update = await cli([
      'libraries',
      'update',
      document,
      '--source',
      source,
      '--write',
      '--json'
    ])
    expect(update.exitCode).toBe(0)
    const result = v.parse(v.pipe(v.string(), v.parseJson(), resultSchema), update.stdout)
    expect(result).toMatchObject({
      current: false,
      updatedDefinitions: ['button'],
      updatedInstances: [],
      removedDefinitions: 0
    })

    const updated = await read(document)
    const edited = [...updated.getAllNodes()].find((node) => node.name === 'Edited')
    expect(edited?.width).toBe(120)
    expect(updated.getChildren(edited?.id ?? '')[0]?.text).toBe('Hello')

    const again = await cli(['libraries', 'update', document, '--source', source, '--json'])
    expect(v.parse(v.pipe(v.string(), v.parseJson(), resultSchema), again.stdout).current).toBe(
      true
    )

    // A library the document does not use is not added to it.
    const saved = await readFile(document)
    const other = await cli([
      'libraries',
      'update',
      document,
      '--source',
      source,
      '--id',
      'other',
      '--write',
      '--json'
    ])
    expect(v.parse(v.pipe(v.string(), v.parseJson(), resultSchema), other.stdout).used).toBe(false)
    expect(await readFile(document)).toEqual(saved)
  })

  test('places a library component a script imports by key, bound to the document tokens', async () => {
    await initCodec()
    const dir = await mkdtemp(join(tmpdir(), 'open-pencil-libraries-import-'))
    const source = join(dir, 'library.fig')
    const document = join(dir, 'document.fig')
    const tokens = (graph: SceneGraph, color: Color) => {
      const collection = graph.createCollection('Tokens')
      return graph.createVariable('accent', 'COLOR', collection.id, color)
    }
    const libraryGraph = library(80, 'Go')
    const button = [...libraryGraph.getAllNodes()].find((node) => node.name === 'Button')
    if (!button) throw new Error('Expected the button')
    const accent = tokens(libraryGraph, { r: 0, g: 0, b: 1, a: 1 })
    // A token the document has no namesake for.
    const outline = libraryGraph.createVariable('outline', 'COLOR', accent.collectionId, {
      r: 0,
      g: 0,
      b: 0,
      a: 1
    })
    libraryGraph.updateNode(button.id, {
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true }],
      strokes: [
        {
          type: 'SOLID',
          color: { r: 0, g: 0, b: 0, a: 1 },
          weight: 1,
          opacity: 1,
          visible: true,
          align: 'INSIDE'
        }
      ],
      boundVariables: { 'fills/0/color': accent.id, 'strokes/0/color': outline.id }
    })
    await Bun.write(source, await exportFigFile(libraryGraph))
    const consumer = new SceneGraph()
    tokens(consumer, { r: 0, g: 0.5, b: 0.4, a: 1 })
    await Bun.write(document, await exportFigFile(consumer))

    const script = `
      const button = await figma.importComponentByKeyAsync('button')
      button.createInstance().name = 'Placed'
      return button.key
    `
    const imported = await cli(
      ['eval', document, '--library', `ds=${source}`, '--variables-by-name', '--stdin', '--write'],
      script
    )
    expect(imported.exitCode).toBe(0)
    expect(imported.stderr).toContain('Variables with no match in the document: outline')

    const placed = await cli([
      'eval',
      document,
      '--json',
      '-c',
      `const main = figma.root.findOne((node) => node.name === 'Placed').mainComponent
       const token = figma.variables.getVariableById(main.boundVariables.fills[0].id)
       return [JSON.parse(main.getPluginData('librarySource')).identity.libraryId, token.name, token.valuesByMode[Object.keys(token.valuesByMode)[0]].g]`
    ])
    expect(JSON.parse(placed.stdout)).toEqual(['ds', 'accent', 0.5])

    const update = await cli(['libraries', 'update', document, '--source', source, '--json'])
    expect(v.parse(v.pipe(v.string(), v.parseJson(), resultSchema), update.stdout).current).toBe(
      true
    )
  })
})
