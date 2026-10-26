import { describe, expect, test } from 'bun:test'

import { FigmaAPI } from '@open-pencil/core/figma-api'
import { SceneGraph } from '@open-pencil/scene-graph'

/** A document whose host brings in the components `library` holds, by key. */
function documentWith(library: Record<string, string>) {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  const imported: string[] = []
  const figma = new FigmaAPI(graph, {
    importComponent: async (key) => {
      imported.push(key)
      const type = library[key]
      if (type !== 'COMPONENT' && type !== 'COMPONENT_SET') return null
      return graph.createNode(type, page.id, { name: key, componentKey: key }).id
    }
  })
  return { figma, imported }
}

describe('importing library components by key', () => {
  test('gives the component the host brought in, which a script can place', async () => {
    const { figma, imported } = documentWith({ button: 'COMPONENT' })

    const button = await figma.importComponentByKeyAsync('button')

    expect(imported).toEqual(['button'])
    expect(button.type).toBe('COMPONENT')
    expect(button.key).toBe('button')
    expect(button.createInstance().type).toBe('INSTANCE')
  })

  test('takes a component set only through importComponentSetByKeyAsync', async () => {
    const { figma } = documentWith({ chip: 'COMPONENT_SET' })

    expect((await figma.importComponentSetByKeyAsync('chip')).type).toBe('COMPONENT_SET')
    await expect(figma.importComponentByKeyAsync('chip')).rejects.toThrow('No library component')
  })

  test('rejects a key no library has, and any key without a host that imports', async () => {
    const { figma } = documentWith({})
    await expect(figma.importComponentByKeyAsync('missing')).rejects.toThrow('missing')
    await expect(
      new FigmaAPI(new SceneGraph()).importComponentByKeyAsync('button')
    ).rejects.toThrow('No library component with key button')
  })
})
