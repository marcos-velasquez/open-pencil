import { describe, expect, test } from 'bun:test'

import { ensureLibraryAssetKeys, isValidLibraryAssetKey } from '@open-pencil/core/library'
import { SceneGraph } from '@open-pencil/scene-graph'

describe('asset keys a library gives from component names', () => {
  test('are valid however the component is named, and distinct among namesakes', () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    for (const name of ['.icon', '--', '★', 'x'.repeat(300), 'Button', 'Button'])
      graph.createNode('COMPONENT', page.id, { name })

    const keys = ensureLibraryAssetKeys(graph).map((assignment) => assignment.assetKey)

    expect(keys.every(isValidLibraryAssetKey)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.slice(0, 3)).toEqual(['icon', 'component', 'component-2'])
  })
})
