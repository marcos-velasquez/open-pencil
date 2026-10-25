import { SceneGraph } from '@open-pencil/scene-graph'
import type { SceneNode } from '@open-pencil/scene-graph'
import {
  cloneInstanceOverrideState,
  deserializeInstanceOverrideState,
  serializeInstanceOverrideState,
  type InstanceOverrideState,
  type SerializedInstanceOverrideState
} from '@open-pencil/scene-graph/instances/overrides'

import type { PortableSceneGraphData } from '#core/kiwi/fig/parse/portable-data'

import type { ComponentLibraryManifest, ComponentLibraryRevision } from './types'

/** A node as a catalog stores it: its instance overrides as arrays, which JSON keeps. */
export type SerializedLibraryNode = Omit<SceneNode, 'instanceOverrides'> & {
  instanceOverrides: SerializedInstanceOverrideState
}

export type SerializedLibraryGraph = Omit<PortableSceneGraphData, 'nodes'> & {
  nodes: Array<[string, SerializedLibraryNode]>
}

export interface SerializedComponentLibraryRevision {
  manifest: ComponentLibraryManifest
  graph: SerializedLibraryGraph
}

function serializeLibraryNode(node: SceneNode): SerializedLibraryNode {
  return {
    ...structuredClone(node),
    instanceOverrides: serializeInstanceOverrideState(node.instanceOverrides)
  }
}

export function serializeLibraryRevision(
  revision: ComponentLibraryRevision
): SerializedComponentLibraryRevision {
  return {
    manifest: structuredClone(revision.manifest),
    graph: {
      rootId: revision.graph.rootId,
      nodes: [...revision.graph.nodes].map(([id, node]) => [id, serializeLibraryNode(node)]),
      images: [...revision.graph.images].map(([hash, bytes]) => [hash, new Uint8Array(bytes)]),
      variables: [...revision.graph.variables].map(([id, variable]) => [
        id,
        structuredClone(variable)
      ]),
      variableCollections: [...revision.graph.variableCollections].map(([id, collection]) => [
        id,
        structuredClone(collection)
      ]),
      activeMode: [...revision.graph.activeMode],
      documentColorSpace: revision.graph.documentColorSpace
    }
  }
}

function isInstanceOverrideState(state: unknown): state is InstanceOverrideState {
  return !!state && typeof state === 'object' && 'self' in state && state.self instanceof Map
}

/**
 * The override state of a stored node. A revision stored before overrides were serialized keeps
 * them as `Map`s when it was structured-cloned, and as `{}` once it went through JSON.
 */
function restoreInstanceOverrides(state: unknown): InstanceOverrideState {
  return isInstanceOverrideState(state)
    ? cloneInstanceOverrideState(state)
    : deserializeInstanceOverrideState(state)
}

function cloneLibraryNode(node: SerializedLibraryNode): SceneNode {
  const { instanceOverrides, ...fields } = structuredClone(node)
  const cloned: SceneNode = {
    ...fields,
    instanceOverrides: restoreInstanceOverrides(instanceOverrides)
  }
  return Array.isArray(cloned.guides) ? cloned : { ...cloned, guides: [] }
}

export function deserializeLibraryRevision(
  revision: SerializedComponentLibraryRevision
): ComponentLibraryRevision {
  const graph = new SceneGraph()
  graph.rootId = revision.graph.rootId
  graph.nodes = new Map(revision.graph.nodes.map(([id, node]) => [id, cloneLibraryNode(node)]))
  graph.images = new Map(
    revision.graph.images.map(([hash, bytes]) => [hash, new Uint8Array(bytes)])
  )
  graph.variables = new Map(revision.graph.variables)
  graph.variableCollections = new Map(revision.graph.variableCollections)
  graph.activeMode = new Map(revision.graph.activeMode)
  graph.documentColorSpace = revision.graph.documentColorSpace
  graph.instanceIndex = new Map()
  for (const node of graph.getAllNodes()) {
    if (node.type === 'CONNECTOR') graph.connectorIds.add(node.id)
    if (!node.componentId) continue
    const instances = graph.instanceIndex.get(node.componentId) ?? new Set<string>()
    instances.add(node.id)
    graph.instanceIndex.set(node.componentId, instances)
  }
  return { manifest: structuredClone(revision.manifest), graph }
}
