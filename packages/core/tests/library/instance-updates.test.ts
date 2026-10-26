import { describe, expect, test } from 'bun:test'

import {
  createLibraryRevision,
  materializeLibraryAsset,
  planOutdatedLibraryInstances,
  swapLibraryInstance,
  type ComponentLibraryRevision
} from '@open-pencil/core/library'
import { SceneGraph, type SceneNode } from '@open-pencil/scene-graph'
import { hasInstanceOverride, recordInstanceOverride } from '@open-pencil/scene-graph/instances'
import { getInstanceOverride } from '@open-pencil/scene-graph/instances/overrides'

interface Revision {
  width: number
  label: string
  /** Layers the button holds after its label. */
  extras?: string[]
}

/** A library whose button holds an icon instance, a label, and `extras`, with two icons. */
function library({ width, label, extras = [] }: Revision): SceneGraph {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  for (const [index, name] of ['Zap', 'Star'].entries()) {
    const icon = graph.createNode('COMPONENT', page.id, {
      name,
      componentKey: name.toLowerCase(),
      x: 200 + index * 40
    })
    graph.createNode('ELLIPSE', icon.id, { name: 'Glyph', width: 16, height: 16 })
  }
  const button = graph.createNode('COMPONENT', page.id, {
    name: 'Button',
    componentKey: 'button',
    width
  })
  const zap = [...graph.getAllNodes()].find((node) => node.componentKey === 'zap')
  graph.createInstance(zap?.id ?? '', button.id, { name: 'Icon' })
  graph.createNode('TEXT', button.id, { name: 'Label', text: label })
  for (const name of extras) graph.createNode('TEXT', button.id, { name, text: name })
  return graph
}

let previous: string | null = null
async function revisionOf(source: Revision): Promise<ComponentLibraryRevision> {
  const revision = await createLibraryRevision({
    libraryId: 'design-system',
    name: 'Design system',
    graph: library(source),
    previousRevisionId: previous
  })
  previous = revision.manifest.revisionId
  return revision
}

function layer(graph: SceneGraph, parentId: string, name: string, rank = 0): SceneNode {
  const found = graph.getChildren(parentId).filter((node) => node.name === name)[rank]
  if (!found) throw new Error(`Expected ${name} #${rank} in ${parentId}`)
  return found
}

/** A document with an instance of the first revision, edited by `edit`, updated to the second. */
async function updated(
  first: Revision,
  second: Revision,
  edit: (graph: SceneGraph, id: string) => void
) {
  previous = null
  const old = await revisionOf(first)
  const latest = await revisionOf(second)
  const graph = new SceneGraph()
  const { componentId } = materializeLibraryAsset(graph, old, 'button')
  materializeLibraryAsset(graph, old, 'star')
  const instance = graph.createInstance(componentId, graph.getPages()[0].id)
  if (!instance) throw new Error('Expected the instance')
  edit(graph, instance.id)
  materializeLibraryAsset(graph, latest, 'button')
  materializeLibraryAsset(graph, latest, 'star')
  for (const plan of planOutdatedLibraryInstances(graph, latest))
    swapLibraryInstance(graph, plan.instanceId, plan.componentId)
  return { graph, instance: instance.id }
}

describe('updating a library instance to another revision', () => {
  test('keeps its overrides and takes the rest of the new revision', async () => {
    const { graph, instance } = await updated(
      { width: 80, label: 'Old' },
      { width: 120, label: 'New' },
      (graph, id) => {
        const label = layer(graph, id, 'Label')
        graph.updateNode(label.id, { text: 'Hello', opacity: 0.5 })
        recordInstanceOverride(graph, label.id, ['text', 'opacity'])
      }
    )
    const label = layer(graph, instance, 'Label')
    expect(graph.getNode(instance)?.width).toBe(120)
    expect(label).toMatchObject({ text: 'Hello', opacity: 0.5 })
    expect(hasInstanceOverride(graph, label.id, 'text')).toBe(true)
  })

  test('keeps a nested instance it swapped to another component', async () => {
    const { graph, instance } = await updated(
      { width: 80, label: 'Old' },
      { width: 120, label: 'New' },
      (graph, id) => {
        const star = [...graph.getAllNodes()].find((node) => node.name === 'Star')
        graph.swapInstanceComponent(layer(graph, id, 'Icon').id, star?.id ?? '')
      }
    )
    const icon = graph.getChildren(instance).find((node) => node.type === 'INSTANCE')
    expect(graph.getNode(icon?.componentId ?? '')?.name).toBe('Star')
  })

  test('keeps a variable it bound', async () => {
    let accent = ''
    const { graph, instance } = await updated(
      { width: 80, label: 'Old' },
      { width: 120, label: 'New' },
      (graph, id) => {
        const collection = graph.createCollection('Tokens')
        accent = graph.createVariable('accent', 'COLOR', collection.id, {
          r: 0,
          g: 0.5,
          b: 0.4,
          a: 1
        }).id
        const label = layer(graph, id, 'Label')
        graph.updateNode(label.id, {
          fills: [
            { type: 'SOLID', color: { r: 0, g: 0.5, b: 0.4, a: 1 }, opacity: 1, visible: true }
          ]
        })
        graph.bindVariable(label.id, 'fills/0/color', accent)
        recordInstanceOverride(graph, label.id, ['fills', 'boundVariables'])
      }
    )
    const label = layer(graph, instance, 'Label')
    const owner = graph.getNode(instance)
    if (!owner) throw new Error('Expected the instance')
    const bound = getInstanceOverride(
      owner.instanceOverrides,
      instance,
      label.id,
      'boundVariables/fills/0/color'
    )
    expect(bound).toBe(accent)
  })

  test('drops the overrides of a layer the new revision no longer has', async () => {
    const { graph, instance } = await updated(
      { width: 80, label: 'Old', extras: ['Hint'] },
      { width: 120, label: 'New' },
      (graph, id) => {
        const hint = layer(graph, id, 'Hint')
        graph.updateNode(hint.id, { text: 'Edited hint' })
        recordInstanceOverride(graph, hint.id, ['text'])
      }
    )
    expect(graph.getChildren(instance).map((node) => node.name)).toEqual(['Icon', 'Label'])
    expect(graph.getNode(instance)?.instanceOverrides.descendants.size).toBe(0)
  })

  test('lands each override on the layer of the same name and place among namesakes', async () => {
    const { graph, instance } = await updated(
      { width: 80, label: 'Old', extras: ['Note', 'Note'] },
      { width: 120, label: 'New', extras: ['Note', 'Note'] },
      (graph, id) => {
        const second = layer(graph, id, 'Note', 1)
        graph.updateNode(second.id, { text: 'Second' })
        recordInstanceOverride(graph, second.id, ['text'])
      }
    )
    expect(layer(graph, instance, 'Note', 0).text).toBe('Note')
    expect(layer(graph, instance, 'Note', 1).text).toBe('Second')
  })

  test('tells apart a layer whose name looks like a path from the layer it seems to name', async () => {
    // Read as text, the name would be the path of the icon's glyph.
    const tricky = 'Icon#0/Glyph'
    const { graph, instance } = await updated(
      { width: 80, label: 'Old', extras: [tricky] },
      { width: 120, label: 'New', extras: [tricky] },
      (graph, id) => {
        const named = layer(graph, id, tricky)
        graph.updateNode(named.id, { text: 'Kept' })
        recordInstanceOverride(graph, named.id, ['text'])
      }
    )
    expect(layer(graph, instance, tricky).text).toBe('Kept')
  })

  test('keeps the scale of a numeric variable it bound', async () => {
    const { graph, instance } = await updated(
      { width: 80, label: 'Old' },
      { width: 120, label: 'New' },
      (graph, id) => {
        const collection = graph.createCollection('Tokens')
        const fade = graph.createVariable('fade', 'FLOAT', collection.id, 0.25)
        const label = layer(graph, id, 'Label')
        graph.bindVariable(label.id, 'opacity', fade.id)
        // A binding read from a scaled instance resolves at twice its variable's value.
        graph.updateNode(label.id, { variableBindingScales: { opacity: 2 } })
        recordInstanceOverride(graph, label.id, ['opacity', 'boundVariables'])
      }
    )
    expect(layer(graph, instance, 'Label').variableBindingScales.opacity).toBe(2)
  })
})
