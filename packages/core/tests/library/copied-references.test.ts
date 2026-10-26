import { describe, expect, test } from 'bun:test'

import { createLibraryRevision, materializeLibraryAsset } from '@open-pencil/core/library'
import { SceneGraph } from '@open-pencil/scene-graph'

/** A library whose button swaps its icon through an instance-swap property. */
function libraryWithIconProperty() {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  const star = graph.createNode('COMPONENT', page.id, { name: 'Star', componentKey: 'star' })
  const heart = graph.createNode('COMPONENT', page.id, { name: 'Heart', componentKey: 'heart' })
  const button = graph.createNode('COMPONENT', page.id, {
    name: 'Button',
    componentKey: 'button',
    componentPropertyDefinitions: [
      { id: 'icon', name: 'Icon', type: 'INSTANCE_SWAP', defaultValue: star.id }
    ]
  })
  const icon = graph.createInstance(star.id, button.id)
  if (!icon) throw new Error('Expected the icon instance')
  graph.updateNode(icon.id, {
    componentPropertyReferences: [{ propertyId: 'icon', field: 'mainComponent' }]
  })
  const card = graph.createNode('COMPONENT', page.id, { name: 'Card', componentKey: 'card' })
  const cardButton = graph.createInstance(button.id, card.id)
  if (!cardButton) throw new Error('Expected the card button')
  graph.updateNode(cardButton.id, { componentPropertyAssignments: { icon: heart.id } })
  return graph
}

const named = (graph: SceneGraph, id: string | undefined) => (id ? graph.getNode(id)?.name : null)

describe('references between copied library layers', () => {
  test('point instance-swap properties at the copied components', async () => {
    const revision = await createLibraryRevision({
      libraryId: 'design-system',
      name: 'Design system',
      graph: libraryWithIconProperty()
    })
    const stored = revision.graph
    const button = [...stored.getAllNodes()].find((node) => node.componentKey === 'button')
    const cardButton = [...stored.getAllNodes()].find(
      (node) => node.type === 'INSTANCE' && node.name === 'Button'
    )
    expect(named(stored, button?.componentPropertyDefinitions[0]?.defaultValue)).toBe('Star')
    expect(named(stored, cardButton?.componentPropertyAssignments.icon)).toBe('Heart')

    const consumer = new SceneGraph()
    const { componentId } = materializeLibraryAsset(consumer, revision, 'button')
    const definition = consumer.getNode(componentId)?.componentPropertyDefinitions[0]
    expect(named(consumer, definition?.defaultValue)).toBe('Star')
  })
})
