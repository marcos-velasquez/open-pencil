import { describe, expect, test } from 'bun:test'

import { SceneGraph } from '@open-pencil/scene-graph'
import {
  copiedComponentLayerId,
  setInstanceOverride
} from '@open-pencil/scene-graph/instances/overrides'

describe('instance sync', () => {
  test('links a copy to the namesake that replaces its layer, over the link a file recorded', () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0].id
    const component = graph.createNode('COMPONENT', page, { name: 'Button' })
    const old = graph.createNode('TEXT', component.id, { name: 'Label', text: 'Old' })
    const instance = graph.createInstance(component.id, page)
    const copy = instance ? graph.getChildren(instance.id)[0] : undefined
    if (!instance || !copy) throw new Error('Expected the instance and its copy')
    // A document read from a file records the component layer each copy draws.
    setInstanceOverride(instance.instanceOverrides, instance.id, copy.id, 'sourceComponentId', old.id)

    // The component's layer is replaced by a namesake before its instances sync.
    const label = graph.createNode('TEXT', component.id, { name: 'Label', text: 'New' })
    graph.deleteNode(old.id)
    graph.syncInstances(component.id)

    const [synced] = graph.getChildren(instance.id)
    expect(synced?.text).toBe('New')
    expect(copiedComponentLayerId(instance.instanceOverrides, instance.id, synced)).toBe(label.id)
  })
})
