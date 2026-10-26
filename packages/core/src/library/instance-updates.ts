import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import { findInstanceAncestor, recordInstanceOverride } from '@open-pencil/scene-graph/instances'
import {
  getInstanceOverride,
  setInstanceOverride
} from '@open-pencil/scene-graph/instances/overrides'

import { findLibraryDefinition } from './definitions'
import type { ComponentLibraryRevision, LibraryAssetDescriptor } from './types'
import type { LibraryInstanceUpdate } from './update'

export function libraryAssetKeyForComponent(graph: SceneGraph, componentId: string): string | null {
  let node = graph.getNode(componentId)
  while (node) {
    const identity = node.librarySource?.identity
    if (identity) return identity.assetKey
    node = node.parentId ? graph.getNode(node.parentId) : undefined
  }
  return null
}

function targetComponentId(
  graph: SceneGraph,
  descriptor: LibraryAssetDescriptor,
  revision: ComponentLibraryRevision,
  previousComponentId: string
): { id: string; fallback: boolean } | null {
  const root = findLibraryDefinition(
    graph,
    revision.manifest.libraryId,
    descriptor.key,
    revision.manifest.revisionId
  )
  if (!root) return null
  const candidates =
    root.type === 'COMPONENT'
      ? [root]
      : graph.getChildren(root.id).filter((node) => node.type === 'COMPONENT')
  const previous = graph.getNode(previousComponentId)
  if (!previous) return null
  const exact = candidates.find((candidate) => {
    const entries = Object.entries(previous.componentPropertyValues)
    return (
      entries.length === Object.keys(candidate.componentPropertyValues).length &&
      entries.every(([name, value]) => candidate.componentPropertyValues[name] === value)
    )
  })
  if (candidates.length === 0) return null
  const fallback = [...candidates].sort((left, right) => left.y - right.y || left.x - right.x)[0]
  const target = exact ?? fallback
  return { id: target.id, fallback: !exact }
}

export function planOutdatedLibraryInstances(
  graph: SceneGraph,
  revision: ComponentLibraryRevision,
  assetKeys?: ReadonlySet<string>,
  instanceIds?: ReadonlySet<string>
): LibraryInstanceUpdate[] {
  const descriptors = new Map(revision.manifest.assets.map((asset) => [asset.key, asset]))
  const updates: LibraryInstanceUpdate[] = []
  for (const instance of graph.getAllNodes()) {
    if (instance.type !== 'INSTANCE' || !instance.componentId) continue
    if (instanceIds && !instanceIds.has(instance.id)) continue
    const component = graph.getNode(instance.componentId)
    const identity = component?.librarySource?.identity
    if (!identity || identity.libraryId !== revision.manifest.libraryId) continue
    const assetKey = libraryAssetKeyForComponent(graph, component.id)
    if (!assetKey || (assetKeys && !assetKeys.has(assetKey))) continue
    if (identity.revisionId === revision.manifest.revisionId) continue
    const descriptor = descriptors.get(assetKey)
    if (!descriptor) continue
    const target = targetComponentId(graph, descriptor, revision, component.id)
    if (!target) continue
    updates.push({
      instanceId: instance.id,
      previousComponentId: component.id,
      componentId: target.id,
      fallback: target.fallback
    })
  }
  return updates
}

/**
 * The layer of the component that `node` draws: the one its instance records as its source, as a
 * swap records it, else the one it copies. Its name is the library's, which neither a rename nor
 * a swap in the document changes.
 */
function sourceLayer(graph: SceneGraph, rootId: string, node: SceneNode): SceneNode {
  for (let id = node.parentId; id;) {
    const owner = graph.getNode(id)
    if (!owner) break
    if (owner.type === 'INSTANCE') {
      const recorded = getInstanceOverride(
        owner.instanceOverrides,
        owner.id,
        node.id,
        'sourceComponentId'
      )
      const source = typeof recorded === 'string' ? graph.getNode(recorded) : undefined
      if (source) return source
    }
    if (id === rootId) break
    id = owner.parentId
  }
  const copied = node.componentId ? graph.getNode(node.componentId) : undefined
  return copied && copied.type !== 'COMPONENT' && copied.type !== 'COMPONENT_SET' ? copied : node
}

/**
 * A layer's place in an instance: the names of the component layers down to it, each with its
 * rank among namesakes, as a JSON list, so no name can be read as two levels.
 */
function layerPath(graph: SceneGraph, rootId: string, node: SceneNode): string {
  const name = (layer: SceneNode) => sourceLayer(graph, rootId, layer).name
  const parts: [name: string, rank: number][] = []
  for (let id: string | null = node.id; id && id !== rootId;) {
    const layer = graph.getNode(id)
    if (!layer) break
    const siblings = (layer.parentId ? graph.getChildren(layer.parentId) : []).filter(
      (sibling) => name(sibling) === name(layer)
    )
    parts.unshift([name(layer), siblings.findIndex((sibling) => sibling.id === layer.id)])
    id = layer.parentId
  }
  return JSON.stringify(parts)
}

/** Drops the overrides an instance keeps for layers a swap removed. */
function dropStaleOverrides(graph: SceneGraph, instanceId: string): void {
  const instance = graph.getNode(instanceId)
  if (!instance) return
  for (const id of instance.instanceOverrides.descendants.keys()) {
    if (!graph.getNode(id) || !graph.isDescendant(id, instanceId))
      instance.instanceOverrides.descendants.delete(id)
  }
}

interface CapturedOverride {
  path: string
  /** A swap of a nested instance, applied before the fields, since it rebuilds the layers. */
  componentId?: string
  fields: Partial<Record<string, unknown>>
  bindings: [field: string, value: unknown][]
  /** The scale each bound field reads its variable at, `undefined` for none; it goes with the binding. */
  scales: Map<string, number | undefined>
}

function captureScales(entry: CapturedOverride, target: SceneNode, fields: Iterable<string>): void {
  for (const field of fields) entry.scales.set(field, target.variableBindingScales[field])
}

/** The overrides the instance `rootId` and the instances in it carry, by the place of each layer. */
function captureOverrides(graph: SceneGraph, rootId: string): CapturedOverride[] {
  const captured: CapturedOverride[] = []
  const queue = [rootId]
  for (const id of queue) {
    const node = graph.getNode(id)
    if (!node) continue
    queue.push(...node.childIds)
    if (node.type !== 'INSTANCE') continue
    const states = [...node.instanceOverrides.descendants]
    // A nested instance's own fields are overrides of the layer it is in the root instance.
    if (id !== rootId) states.push([id, node.instanceOverrides.self])
    for (const [targetId, overridden] of states) {
      const target = graph.getNode(targetId)
      if (!target) continue
      const entry: CapturedOverride = {
        path: layerPath(graph, rootId, target),
        fields: {},
        bindings: [],
        scales: new Map()
      }
      for (const [field, value] of overridden) {
        if (field === 'sourceComponentId') continue
        if (field === 'componentId' && typeof value === 'string') entry.componentId = value
        else if (field.startsWith('boundVariables/')) {
          entry.bindings.push([field, value])
          captureScales(entry, target, [field.slice('boundVariables/'.length)])
        } else if (field in target)
          entry.fields[field] = structuredClone(target[field as keyof SceneNode])
        if (field === 'boundVariables')
          captureScales(entry, target, [
            ...Object.keys(target.boundVariables),
            ...Object.keys(target.variableBindingScales)
          ])
      }
      captured.push(entry)
    }
  }
  return captured
}

function layersByPath(graph: SceneGraph, rootId: string): Map<string, SceneNode> {
  const layers = new Map<string, SceneNode>()
  const queue = [...(graph.getNode(rootId)?.childIds ?? [])]
  for (const id of queue) {
    const node = graph.getNode(id)
    if (!node) continue
    layers.set(layerPath(graph, rootId, node), node)
    queue.push(...node.childIds)
  }
  return layers
}

/**
 * Points an instance at another revision of its library component, keeping the overrides its
 * layers carry, as Figma does when it updates a library component: each lands on the layer with
 * the same name and place in the new revision, and one whose layer is gone is dropped.
 */
export function swapLibraryInstance(
  graph: SceneGraph,
  instanceId: string,
  componentId: string
): void {
  const captured = captureOverrides(graph, instanceId)
  graph.swapInstanceComponent(instanceId, componentId)
  dropStaleOverrides(graph, instanceId)
  for (const entry of captured) {
    if (!entry.componentId || !graph.getNode(entry.componentId)) continue
    const target = layersByPath(graph, instanceId).get(entry.path)
    if (target?.type === 'INSTANCE') graph.swapInstanceComponent(target.id, entry.componentId)
  }
  const layers = layersByPath(graph, instanceId)
  for (const entry of captured) {
    const target = layers.get(entry.path)
    if (!target) continue
    const scales = { ...target.variableBindingScales }
    for (const [field, scale] of entry.scales) {
      if (scale === undefined) Reflect.deleteProperty(scales, field)
      else scales[field] = scale
    }
    graph.updateNode(target.id, {
      ...entry.fields,
      ...(entry.scales.size > 0 && { variableBindingScales: scales })
    } as Partial<SceneNode>)
    recordInstanceOverride(graph, target.id, Object.keys(entry.fields))
    const owner = findInstanceAncestor(graph, target.id)
    if (!owner) continue
    for (const [field, value] of entry.bindings) {
      setInstanceOverride(owner.instanceOverrides, owner.id, target.id, field, value)
    }
  }
}
