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

/**
 * A document holding an overridden instance of a library button, with a newer revision published
 * that widens the button, relabels it and adds a badge.
 */
async function updatable() {
  const library = source(80, 'Old')
  const catalog = new MemoryLibraryCatalog()
  const first = await catalog.publishRevision({
    libraryId: 'library',
    name: 'Library',
    graph: library,
    publishedAt: '2026-01-01T00:00:00Z'
  })
  const button = [...library.getAllNodes()].find((node) => node.componentKey === 'button')
  if (!button) throw new Error('Expected the button')
  library.updateNode(button.id, { width: 120 })
  library.updateNode(library.getChildren(button.id)[0]?.id ?? '', { text: 'New' })
  library.createNode('TEXT', button.id, { name: 'Badge', text: '1' })
  await catalog.publishRevision({
    libraryId: 'library',
    name: 'Library',
    graph: library,
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
  return { graph, instance, componentId, editor, service }
}

describe('library service updates', () => {
  test('redraws a library in place, keeping an instance’s component and overrides through undo and redo', async () => {
    const { graph, instance, componentId, editor, service } = await updatable()

    await service.applyUpdate(editor, 'library')
    expect(graph.getNode(instance.id)?.componentId).toBe(componentId)
    expect(graph.getNode(instance.id)?.width).toBe(120)
    expect(graph.getChildren(instance.id)[0]?.text).toBe('Hello')

    editor.undo.undo()
    expect(graph.getNode(componentId)?.width).toBe(80)
    expect(graph.getNode(instance.id)?.width).toBe(80)
    expect(graph.getChildren(instance.id)[0]?.text).toBe('Hello')

    editor.undo.redo()
    expect(graph.getNode(instance.id)?.width).toBe(120)
    expect(graph.getChildren(instance.id)[0]?.text).toBe('Hello')
  })

  test('redoes an update as it left the document, so the layers it added keep their IDs', async () => {
    const { graph, instance, editor, service } = await updatable()
    const badges = () =>
      graph
        .getChildren(instance.id)
        .filter((node) => node.name === 'Badge')
        .map((node) => node.id)

    await service.applyUpdate(editor, 'library')
    const added = badges()
    expect(added).toHaveLength(1)

    editor.undo.undo()
    expect(badges()).toEqual([])
    editor.undo.redo()
    expect(badges()).toEqual(added)
  })

  test('leaves no step to undo when the library has no update left', async () => {
    const { graph, instance, editor, service } = await updatable()

    await service.applyUpdate(editor, 'library')
    await service.applyUpdate(editor, 'library')
    editor.undo.undo()
    expect(graph.getNode(instance.id)?.width).toBe(80)
  })

  test('redraws an asset group in place, keeping its instances’ components and overrides', async () => {
    const { graph, instance, componentId, editor, service } = await updatable()
    const [group] = await service.getUpdateGroups(editor)
    if (!group) throw new Error('Expected an update group')

    await service.applyUpdateGroups(editor, [group])
    expect(graph.getNode(instance.id)?.componentId).toBe(componentId)
    expect(graph.getNode(instance.id)?.width).toBe(120)
    expect(graph.getChildren(instance.id)[0]?.text).toBe('Hello')
  })
})
