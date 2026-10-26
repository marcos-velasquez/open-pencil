import { mapValues } from 'es-toolkit'
import { groupBy } from 'es-toolkit/array'

import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import { cloneNodeProps } from '@open-pencil/scene-graph/copy'
import { remapInstanceOverrideState } from '@open-pencil/scene-graph/instances/overrides'

import { componentSyncOrder } from '#core/editor/component-sync'

import {
  copyImages,
  copyLibraryTree,
  getInternalLibraryPage,
  libraryDefinitionSource
} from './materialize'
import type { ComponentLibraryRevision } from './types'

export interface LibraryDefinitionUpdateOptions {
  /** The document's variable for a variable of the revision; the revision's own by default. */
  variable?: (id: string) => string
}

export interface LibraryDefinitionUpdate {
  /** Asset keys whose definitions now draw the revision. */
  updated: string[]
  /** Asset keys the revision draws as another kind of layer, whose instances must swap. */
  replaced: string[]
  /** Asset keys the revision no longer has. */
  missing: string[]
}

/** A document layer and the revision layer it draws, with the tree both belong to. */
interface DefinitionPair {
  source: SceneNode
  target: SceneNode
  /** The document's layers of the tree, by the revision layer each one draws. */
  tree: Map<string, string>
}

function outdatedDefinitionRoots(
  graph: SceneGraph,
  libraryId: string,
  revisionId: string
): SceneNode[] {
  return graph
    .getPages(true)
    .filter((page) => page.internalOnly)
    .flatMap((page) => graph.getChildren(page.id))
    .filter((node) => {
      const identity = node.librarySource?.identity
      return identity?.libraryId === libraryId && identity.revisionId !== revisionId
    })
}

/** The revision layer a definition draws: its asset's, or the layer it was copied from. */
function revisionRoot(revision: ComponentLibraryRevision, root: SceneNode): SceneNode | undefined {
  const source = root.librarySource
  if (!source) return undefined
  const descriptor = revision.manifest.assets.find(
    (asset) => asset.key === source.identity.assetKey
  )
  const id = descriptor?.sourceNodeId ?? source.sourceNodeId
  return id ? revision.graph.getNode(id) : undefined
}

/** The component, or its set, that a revision layer belongs to, which materializing copies whole. */
function revisionDefinitionRoot(
  revision: ComponentLibraryRevision,
  id: string
): SceneNode | undefined {
  let root: SceneNode | undefined
  for (let node = revision.graph.getNode(id); node && node.type !== 'CANVAS';) {
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') root = node
    node = node.parentId ? revision.graph.getNode(node.parentId) : undefined
  }
  return root
}

/** What pairs a layer across revisions: a variant's key, which a rename keeps, or its kind and name. */
const layerKey = (node: SceneNode) =>
  node.type === 'COMPONENT' && node.componentKey
    ? `COMPONENT#${node.componentKey}`
    : `${node.type}:${node.name}`

/** The component the nearest instance above a layer draws, which the layer's copy points into. */
function enclosingComponent(graph: SceneGraph, node: SceneNode): string | null {
  for (let id = node.parentId; id;) {
    const parent = graph.getNode(id)
    if (parent?.type === 'INSTANCE') return parent.componentId
    id = parent?.parentId ?? null
  }
  return null
}

/** Copies a revision tree into the document, pairing each copy with the layer it draws. */
function copyTree(
  graph: SceneGraph,
  revision: ComponentLibraryRevision,
  sourceId: string,
  parentId: string,
  tree: Map<string, string>,
  pairs: DefinitionPair[]
): void {
  const copied = new Map<string, string>()
  copyLibraryTree(revision.graph, graph, sourceId, parentId, copied)
  for (const [id, targetId] of copied) {
    const source = revision.graph.getNode(id)
    const target = graph.getNode(targetId)
    if (!source || !target) continue
    tree.set(id, targetId)
    pairs.push({ source, target, tree })
  }
}

/**
 * Pairs the layers of `target` with those of the revision layer `source` of the same kind and
 * name, in order, as a library update finds the layer an override names; a variant pairs by its
 * key, and the variants left over pair in order. A revision layer left without a pair is copied
 * in; the layers left without one are returned for removal.
 */
function pairLayers(
  graph: SceneGraph,
  revision: ComponentLibraryRevision,
  source: SceneNode,
  target: SceneNode,
  tree: Map<string, string>,
  pairs: DefinitionPair[]
): string[] {
  tree.set(source.id, target.id)
  pairs.push({ source, target, tree })
  const unpaired = groupBy(graph.getChildren(target.id), layerKey)
  const removed: string[] = []
  const unmatched: SceneNode[] = []
  for (const child of revision.graph.getChildren(source.id)) {
    const pair = unpaired[layerKey(child)]?.shift()
    if (pair) removed.push(...pairLayers(graph, revision, child, pair, tree, pairs))
    else unmatched.push(child)
  }
  // A variant renamed without a key is still the component its instances draw: the variants
  // left on both sides pair in order.
  const left = new Set(Object.values(unpaired).flat())
  const variants = graph
    .getChildren(target.id)
    .filter((layer) => layer.type === 'COMPONENT' && left.has(layer))
  const renamed = new Set<SceneNode>()
  for (const child of unmatched) {
    const pair = child.type === 'COMPONENT' ? variants.shift() : undefined
    if (pair) {
      renamed.add(pair)
      removed.push(...pairLayers(graph, revision, child, pair, tree, pairs))
    } else copyTree(graph, revision, child.id, target.id, tree, pairs)
  }
  for (const layer of left) if (!renamed.has(layer)) removed.push(layer.id)
  return removed
}

/**
 * Brings a document's definitions of a library to a revision in place: each takes the revision's
 * layers and fields but keeps its layers' IDs, so its instances, the copies of those inside other
 * components, and all their overrides keep pointing at it. Its instances then sync in the order
 * the editor syncs an edited component. A definition the revision draws as another kind of layer
 * stays as it was, for its instances to swap.
 */
export function updateLibraryDefinitions(
  graph: SceneGraph,
  revision: ComponentLibraryRevision,
  { variable = (id) => id }: LibraryDefinitionUpdateOptions = {}
): LibraryDefinitionUpdate {
  const { libraryId, revisionId } = revision.manifest
  const result: LibraryDefinitionUpdate = { updated: [], replaced: [], missing: [] }
  const pairs: DefinitionPair[] = []
  const removed: string[] = []
  for (const root of outdatedDefinitionRoots(graph, libraryId, revisionId)) {
    const key = root.librarySource?.identity.assetKey ?? root.id
    const source = revisionRoot(revision, root)
    if (!source) {
      result.missing.push(key)
    } else if (source.type !== root.type) {
      result.replaced.push(key)
    } else {
      removed.push(...pairLayers(graph, revision, source, root, new Map(), pairs))
      result.updated.push(key)
    }
  }

  // A document can hold several copies of a definition, so each revision layer can have several.
  const copies = new Map<string, string[]>()
  const collect = (from: number) => {
    for (const { source, target } of pairs.slice(from)) {
      copies.set(source.id, [...(copies.get(source.id) ?? []), target.id])
    }
  }
  collect(0)
  /**
   * The document's copy of a revision layer: the one a layer already points at, or else the one
   * inside `scope`, the component an instance draws, as the copies inside an instance point into.
   */
  const copyOf = (sourceId: string, previous: string | null, scope: string | null): string => {
    if (!copies.has(sourceId)) {
      // A component the definitions use from this revision on.
      const root = revisionDefinitionRoot(revision, sourceId)
      if (!root) return sourceId
      const from = pairs.length
      copyTree(graph, revision, root.id, getInternalLibraryPage(graph).id, new Map(), pairs)
      collect(from)
    }
    const found = copies.get(sourceId) ?? [sourceId]
    if (previous && found.includes(previous)) return previous
    const inside = scope
      ? found.find((id) => id === scope || graph.isDescendant(id, scope))
      : undefined
    return inside ?? found[0]
  }

  // An instance-swap property names the components it offers by their revision IDs too.
  const swapProperties = new Set(
    [...revision.graph.getAllNodes()].flatMap((node) =>
      node.componentPropertyDefinitions.flatMap((definition) =>
        definition.type === 'INSTANCE_SWAP' ? [definition.id] : []
      )
    )
  )
  // Pairs grow while this runs, as components new to the definitions are copied in.
  for (const { source, target, tree } of pairs) {
    const componentId = source.componentId
      ? copyOf(source.componentId, target.componentId, enclosingComponent(graph, target))
      : null
    // Where a layer came from in its file stays its own, so saving patches it in place.
    const {
      source: _origin,
      overrideKey: _overrideKey,
      ...fields
    } = cloneNodeProps(source, componentId)
    const previousDefaults = new Map(
      target.componentPropertyDefinitions.map((definition) => [
        definition.id,
        definition.defaultValue
      ])
    )
    graph.updateNode(target.id, {
      ...fields,
      componentPropertyDefinitions: (fields.componentPropertyDefinitions ?? []).map((definition) =>
        definition.type === 'INSTANCE_SWAP' && definition.defaultValue
          ? {
              ...definition,
              defaultValue: copyOf(
                definition.defaultValue,
                previousDefaults.get(definition.id) ?? null,
                null
              )
            }
          : definition
      ),
      componentPropertyAssignments: mapValues(
        fields.componentPropertyAssignments ?? {},
        (value, id) =>
          swapProperties.has(id)
            ? copyOf(value, target.componentPropertyAssignments[id] ?? null, null)
            : value
      ),
      locked: true,
      boundVariables: Object.fromEntries(
        Object.entries(source.boundVariables).map(([field, id]) => [field, variable(id)])
      ),
      instanceOverrides: remapInstanceOverrideState(source.instanceOverrides, {
        // The layers an instance's overrides name are inside the component it draws.
        node: (id) => tree.get(id) ?? copyOf(id, null, componentId),
        variable
      }),
      librarySource: libraryDefinitionSource(revision, source.id) ?? target.librarySource
    })
  }
  for (const id of removed) {
    // A variant the revision drops stays while instances draw it, as their component.
    if (graph.getNode(id)?.type === 'COMPONENT' && graph.getInstances(id).length > 0) continue
    graph.deleteNode(id)
  }
  for (const { source, target, tree } of pairs) {
    source.childIds.forEach((childId, index) => {
      const child = tree.get(childId)
      if (child) graph.insertChildAt(child, target.id, index)
    })
  }

  copyImages(
    revision.graph,
    graph,
    new Map(pairs.map(({ source, target }) => [source.id, target.id]))
  )
  graph.enabledLibraries.set(libraryId, { libraryId, revisionId, enabled: true })
  const components = pairs.flatMap(({ target }) => (target.type === 'COMPONENT' ? [target.id] : []))
  graph.syncInstancesTogether(componentSyncOrder(graph, new Set(components)))
  return result
}
