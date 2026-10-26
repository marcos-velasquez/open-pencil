import { describe, expect, test } from 'bun:test'

import { materializeLibraryAsset, MemoryLibraryCatalog } from '@open-pencil/core/library'
import { SceneGraph } from '@open-pencil/scene-graph'
import { recordInstanceOverride } from '@open-pencil/scene-graph/instances'

import { createEditorStore } from '@/app/editor/session'
import { LibraryService } from '@/app/libraries/service'

function source(width: number, label: string) {
  const graph = new SceneGraph()
  const button = graph.createNode('COMPONENT', graph.getPages()[0].id, {
    name: 'Button',
    componentKey: 'button',
    width
  })
  graph.createNode('TEXT', button.id, { name: 'Label', text: label })
  return graph
}

describe('library service updates', () => {
  test('keeps an instance’s overrides through an update and its undo', async () => {
    const catalog = new MemoryLibraryCatalog()
    const first = await catalog.publishRevision({
      libraryId: 'library',
      name: 'Library',
      graph: source(80, 'Old'),
      publishedAt: '2026-01-01T00:00:00Z'
    })
    await catalog.publishRevision({
      libraryId: 'library',
      name: 'Library',
      graph: source(120, 'New'),
      previousRevisionId: first.manifest.revisionId,
      publishedAt: '2026-01-02T00:00:00Z'
    })
    const graph = new SceneGraph()
    const { componentId } = materializeLibraryAsset(graph, first, 'button')
    const instance = graph.createInstance(componentId, graph.getPages()[0].id)
    const label = instance ? graph.getChildren(instance.id)[0] : undefined
    if (!instance || !label) throw new Error('Expected the instance and its label')
    graph.updateNode(label.id, { text: 'Hello' })
    recordInstanceOverride(graph, label.id, ['text'])
    const editor = createEditorStore(graph)
    const service = new LibraryService(catalog)
    await service.listLibraries()
    await service.refresh(editor)

    await service.applyUpdate(editor, 'library')
    expect(graph.getNode(instance.id)?.width).toBe(120)
    expect(graph.getChildren(instance.id)[0]?.text).toBe('Hello')

    editor.undo.undo()
    expect(graph.getNode(instance.id)?.componentId).toBe(componentId)
    expect(graph.getNode(instance.id)?.width).toBe(80)
    expect(graph.getChildren(instance.id)[0]?.text).toBe('Hello')
  })
})
