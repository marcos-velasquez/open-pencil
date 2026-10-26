import { describe, expect, test } from 'bun:test'

import { exportFigFile, parseFigFile, populateAllFigPages } from '@open-pencil/core/io/formats/fig'
import {
  createLibraryRevision,
  materializeLibraryAsset,
  updateLibraryDefinitions
} from '@open-pencil/core/library'
import { initCodec } from '@open-pencil/kiwi/fig/codec'
import { SceneGraph, type SceneNode } from '@open-pencil/scene-graph'
import { recordInstanceOverride } from '@open-pencil/scene-graph/instances'

/** A library whose button holds an icon and a label, and whose card holds a relabeled button. */
function library() {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  const icon = graph.createNode('COMPONENT', page.id, {
    name: 'Icon',
    componentKey: 'icon',
    x: 200
  })
  graph.createNode('ELLIPSE', icon.id, { name: 'Glyph', width: 16, height: 16 })
  const button = graph.createNode('COMPONENT', page.id, {
    name: 'Button',
    componentKey: 'button',
    cornerRadius: 4
  })
  graph.createInstance(icon.id, button.id)
  graph.createNode('TEXT', button.id, { name: 'Label', text: 'Button' })
  const card = graph.createNode('COMPONENT', page.id, {
    name: 'Card',
    componentKey: 'card',
    y: 100
  })
  const remove = graph.createInstance(button.id, card.id, { name: 'Remove' })
  if (!remove) throw new Error('Expected the card button')
  relabel(graph, remove.id, 'Remove')
  return { graph, page, button, icon }
}

/** The graph a saved .fig gives back, whose overrides name the component layers they change. */
async function reopened(graph: SceneGraph): Promise<SceneGraph> {
  await initCodec()
  const bytes = await exportFigFile(graph)
  const read = await parseFigFile(bytes.slice().buffer as ArrayBuffer)
  populateAllFigPages(read)
  return read
}

const revisionOf = (graph: SceneGraph) =>
  createLibraryRevision({ libraryId: 'design-system', name: 'Design system', graph })

function layer(graph: SceneGraph, parentId: string, name: string): SceneNode {
  const found = graph.getChildren(parentId).find((node) => node.name === name)
  if (!found) throw new Error(`Expected ${name} in ${parentId}`)
  return found
}

function relabel(graph: SceneGraph, buttonId: string, text: string): void {
  const label = layer(graph, buttonId, 'Label')
  graph.updateNode(label.id, { text })
  recordInstanceOverride(graph, label.id, ['text'])
}

/** A document that uses the button directly, and through a local component that holds one. */
async function document(source: SceneGraph) {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  const { componentId } = materializeLibraryAsset(graph, await revisionOf(source), 'button')
  const sidebar = graph.createNode('COMPONENT', page.id, { name: 'Sidebar', x: 400 })
  const held = graph.createInstance(componentId, sidebar.id, { name: 'Home' })
  if (!held) throw new Error('Expected the held button')
  relabel(graph, held.id, 'Home')
  const direct = graph.createInstance(componentId, page.id, { name: 'Save' })
  if (!direct) throw new Error('Expected the button')
  relabel(graph, direct.id, 'Save')
  const placed = graph.createInstance(sidebar.id, page.id, { name: 'Placed', y: 200 })
  if (!placed) throw new Error('Expected the sidebar')
  const copy = layer(graph, placed.id, 'Home')
  relabel(graph, copy.id, 'Start')
  return { graph, componentId, held, direct, copy }
}

describe('library definition updates', () => {
  test('keeps each copy of a definition pointing into its own layers', async () => {
    const source = await reopened(library().graph)
    const graph = new SceneGraph()
    const first = await revisionOf(source)
    // The card brings its own copy of the button, apart from the one materialized before it.
    materializeLibraryAsset(graph, first, 'button')
    const { componentId: cardId } = materializeLibraryAsset(graph, first, 'card')
    const button = [...source.getAllNodes()].find((node) => node.componentKey === 'button')
    source.updateNode(button?.id ?? '', { cornerRadius: 12 })
    updateLibraryDefinitions(graph, await revisionOf(source))

    const remove = layer(graph, cardId, 'Remove')
    const named = [...remove.instanceOverrides.descendants.values()].flatMap((fields) => {
      const id = fields.get('sourceComponentId')
      return typeof id === 'string' ? [id] : []
    })
    expect(named.length).toBeGreaterThan(0)
    for (const id of named) expect(graph.isDescendant(id, remove.componentId ?? '')).toBe(true)
    expect(layer(graph, remove.id, 'Label').text).toBe('Remove')
  })

  test('redraws a definition in place, keeping every instance and copy with its overrides', async () => {
    const source = library()
    const doc = await document(source.graph)
    const definitionIds = [
      doc.componentId,
      ...doc.graph.getChildren(doc.componentId).map((node) => node.id)
    ]

    source.graph.updateNode(source.button.id, { cornerRadius: 12 })
    source.graph.createNode('RECTANGLE', source.button.id, { name: 'Badge', width: 6, height: 6 })
    const revision = await revisionOf(source.graph)
    const result = updateLibraryDefinitions(doc.graph, revision)

    // The icon the button holds is a definition of its own, at the same revision.
    expect([...result.updated].sort()).toEqual(['button', 'icon'])
    expect([...result.replaced, ...result.missing]).toEqual([])
    expect(doc.graph.getNode(doc.componentId)?.librarySource?.identity.revisionId).toBe(
      revision.manifest.revisionId
    )
    expect(definitionIds.every((id) => doc.graph.getNode(id))).toBe(true)
    for (const [button, text] of [
      [doc.direct, 'Save'],
      [doc.held, 'Home'],
      [doc.copy, 'Start']
    ] as const) {
      expect(doc.graph.getNode(button.id)?.cornerRadius).toBe(12)
      expect(layer(doc.graph, button.id, 'Label').text).toBe(text)
      expect(layer(doc.graph, button.id, 'Badge').width).toBe(6)
    }
    expect(doc.graph.enabledLibraries.get('design-system')?.revisionId).toBe(
      revision.manifest.revisionId
    )
  })

  test('removes the layers a revision drops and brings in the components it starts using', async () => {
    const source = library()
    const doc = await document(source.graph)

    const icon = source.graph.getChildren(source.button.id).find((node) => node.type === 'INSTANCE')
    if (!icon) throw new Error('Expected the icon')
    source.graph.deleteNode(icon.id)
    const dot = source.graph.createNode('COMPONENT', source.page.id, {
      name: 'Dot',
      componentKey: 'dot',
      x: 300
    })
    source.graph.createNode('ELLIPSE', dot.id, { name: 'Fill', width: 4, height: 4 })
    source.graph.createInstance(dot.id, source.button.id)
    updateLibraryDefinitions(doc.graph, await revisionOf(source.graph))

    for (const button of [doc.direct, doc.held, doc.copy]) {
      const names = doc.graph.getChildren(button.id).map((node) => node.name)
      expect(names).toEqual(['Label', 'Dot'])
      const dotCopy = layer(doc.graph, button.id, 'Dot')
      expect(layer(doc.graph, dotCopy.id, 'Fill').width).toBe(4)
    }
    const definition = layer(doc.graph, doc.componentId, 'Dot')
    expect(doc.graph.getNode(definition.componentId ?? '')?.librarySource?.identity.assetKey).toBe(
      'dot'
    )
  })
})
