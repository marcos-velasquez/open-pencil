import { describe, expect, test } from 'bun:test'

import {
  createLibraryRevision,
  deserializeLibraryRevision,
  diffLibraryManifests,
  ensureLibraryAssetKeys,
  extractLibrarySnapshot,
  MemoryLibraryCatalog,
  serializeLibraryRevision
} from '@open-pencil/core/library'
import { SceneGraph } from '@open-pencil/scene-graph'
import { recordInstanceOverride } from '@open-pencil/scene-graph/instances'

function setupLibraryGraph() {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  if (!page) throw new Error('Expected page')
  const icon = graph.createNode('COMPONENT', page.id, {
    name: 'Icon',
    componentKey: 'icon'
  })
  graph.createNode('ELLIPSE', icon.id, { name: 'Glyph' })
  const button = graph.createNode('COMPONENT', page.id, {
    name: 'Button',
    componentKey: 'button'
  })
  const nestedIcon = graph.createInstance(icon.id, button.id)
  if (!nestedIcon) throw new Error('Expected nested instance')
  return { graph, icon, button }
}

describe('component library snapshots', () => {
  test('extracts selected assets with nested component dependencies and remapped IDs', () => {
    const { graph, icon, button } = setupLibraryGraph()
    const snapshot = extractLibrarySnapshot(graph, [button.id])
    expect(snapshot.assetRoots.map((node) => node.name)).toEqual(['Button'])
    const components = [...snapshot.graph.getAllNodes()].filter((node) => node.type === 'COMPONENT')
    expect(components.map((node) => node.name).sort()).toEqual(['Button', 'Icon'])
    const importedButton = snapshot.assetRoots[0]
    const importedNested = importedButton
      ? snapshot.graph.getChildren(importedButton.id).find((node) => node.type === 'INSTANCE')
      : undefined
    expect(importedNested?.componentId).not.toBe(icon.id)
    expect(snapshot.graph.getNode(importedNested?.componentId ?? '')?.name).toBe('Icon')
  })

  test('creates deterministic content revisions independent of local node IDs', async () => {
    const first = setupLibraryGraph()
    const second = setupLibraryGraph()
    const inputs = {
      libraryId: 'design-system',
      name: 'Design system',
      publishedAt: '2026-01-01T00:00:00.000Z'
    }
    const firstRevision = await createLibraryRevision({ ...inputs, graph: first.graph })
    const secondRevision = await createLibraryRevision({ ...inputs, graph: second.graph })
    expect(firstRevision.manifest.revisionId).toBe(secondRevision.manifest.revisionId)
    expect(firstRevision.manifest.assets.map((asset) => asset.key).sort()).toEqual([
      'button',
      'icon'
    ])

    first.graph.updateNode(first.button.id, { opacity: 0.5 })
    const changedRevision = await createLibraryRevision({ ...inputs, graph: first.graph })
    expect(changedRevision.manifest.revisionId).not.toBe(firstRevision.manifest.revisionId)
  })

  test('diffs revisions by stable asset key', async () => {
    const { graph, button, icon } = setupLibraryGraph()
    const base = await createLibraryRevision({
      libraryId: 'design-system',
      name: 'Design system',
      graph,
      publishedAt: '2026-01-01T00:00:00.000Z'
    })
    graph.updateNode(button.id, { opacity: 0.5 })
    graph.updateNode(icon.id, { name: 'System icon' })
    const next = await createLibraryRevision({
      libraryId: 'design-system',
      name: 'Design system',
      graph,
      previousRevisionId: base.manifest.revisionId,
      publishedAt: '2026-01-02T00:00:00.000Z'
    })
    expect(diffLibraryManifests(base.manifest, next.manifest).map((change) => change.kind)).toEqual(
      ['renamed', 'modified']
    )
  })

  test('assigns durable unique keys once and preserves them across rename', () => {
    const { graph, button, icon } = setupLibraryGraph()
    graph.updateNode(button.id, { componentKey: null })
    graph.updateNode(icon.id, { componentKey: null })
    expect(
      ensureLibraryAssetKeys(graph)
        .map((assignment) => assignment.assetKey)
        .sort()
    ).toEqual(['button', 'icon'])
    graph.updateNode(button.id, { name: 'Primary action' })
    expect(
      ensureLibraryAssetKeys(graph).find((assignment) => assignment.nodeId === button.id)
    ).toEqual({
      nodeId: button.id,
      assetKey: 'button',
      existing: true
    })
  })

  test('serializes portable revisions without losing component links', async () => {
    const { graph } = setupLibraryGraph()
    const revision = await createLibraryRevision({
      libraryId: 'design-system',
      name: 'Design system',
      graph
    })
    const restored = deserializeLibraryRevision(structuredClone(serializeLibraryRevision(revision)))
    expect(restored.manifest).toEqual(revision.manifest)
    const button = [...restored.graph.getAllNodes()].find((node) => node.componentKey === 'button')
    const nested = button
      ? restored.graph.getChildren(button.id).find((node) => node.type === 'INSTANCE')
      : undefined
    expect(restored.graph.getNode(nested?.componentId ?? '')?.componentKey).toBe('icon')
  })

  test('keeps the overrides of nested instances, under the IDs of the stored layers', async () => {
    const { graph, button } = setupLibraryGraph()
    const nested = graph.getChildren(button.id).find((node) => node.type === 'INSTANCE')
    const glyph = nested ? graph.getChildren(nested.id)[0] : undefined
    if (!nested || !glyph) throw new Error('Expected a nested instance with a copy')
    graph.updateNode(glyph.id, { opacity: 0.5 })
    recordInstanceOverride(graph, glyph.id, ['opacity'])
    const revision = await createLibraryRevision({
      libraryId: 'design-system',
      name: 'Design system',
      graph
    })
    // A catalog that stores revisions as JSON, as files and remote storage do.
    // eslint-disable-next-line unicorn/prefer-structured-clone -- exercise the JSON boundary
    const stored = JSON.parse(JSON.stringify(serializeLibraryRevision(revision)))
    const restored = deserializeLibraryRevision(stored).graph
    const restoredButton = [...restored.getAllNodes()].find(
      (node) => node.componentKey === 'button'
    )
    const restoredNested = restoredButton
      ? restored.getChildren(restoredButton.id).find((node) => node.type === 'INSTANCE')
      : undefined
    const restoredGlyph = restoredNested ? restored.getChildren(restoredNested.id)[0] : undefined
    if (!restoredNested || !restoredGlyph) throw new Error('Expected the restored copy')
    expect([...restoredNested.instanceOverrides.descendants.keys()]).toEqual([restoredGlyph.id])
    expect(restoredNested.instanceOverrides.descendants.get(restoredGlyph.id)?.has('opacity')).toBe(
      true
    )
  })

  test('reads overrides of revisions stored before they were serialized', () => {
    const { graph, button } = setupLibraryGraph()
    const snapshot = extractLibrarySnapshot(graph, [button.id]).graph
    const legacy = {
      manifest: {
        schemaVersion: 1,
        libraryId: 'design-system',
        name: 'Design system',
        revisionId: 'legacy',
        previousRevisionId: null,
        publishedAt: '2026-01-01T00:00:00.000Z',
        description: '',
        assets: []
      },
      graph: {
        rootId: snapshot.rootId,
        // JSON wrote each override `Map` as an empty object.
        nodes: [...snapshot.nodes].map(([id, node]) => [id, { ...node, instanceOverrides: {} }]),
        images: [],
        variables: [],
        variableCollections: [],
        activeMode: [],
        documentColorSpace: 'srgb'
      }
    }
    // eslint-disable-next-line unicorn/prefer-structured-clone -- exercise the JSON boundary
    const restored = deserializeLibraryRevision(JSON.parse(JSON.stringify(legacy))).graph
    for (const node of restored.getAllNodes()) {
      expect(node.instanceOverrides.self).toBeInstanceOf(Map)
      expect(node.instanceOverrides.descendants).toBeInstanceOf(Map)
    }
  })

  test('publishes immutable revisions with optimistic conflict detection', async () => {
    const { graph } = setupLibraryGraph()
    const catalog = new MemoryLibraryCatalog()
    const first = await catalog.publishRevision({
      libraryId: 'design-system',
      name: 'Design system',
      graph,
      publishedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(await catalog.listLibraries()).toEqual([
      {
        libraryId: 'design-system',
        name: 'Design system',
        latestRevisionId: first.manifest.revisionId,
        publishedAt: '2026-01-01T00:00:00.000Z',
        assetCount: 2
      }
    ])
    await expect(
      catalog.publishRevision({
        libraryId: 'design-system',
        name: 'Design system',
        graph,
        previousRevisionId: 'stale'
      })
    ).rejects.toThrow('latest revision has changed')
  })
})
