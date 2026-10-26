import { isEqual } from 'es-toolkit/predicate'

import type { NodeChange, Paint } from '@open-pencil/kiwi/fig/codec'
import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import { setInstanceOverride } from '@open-pencil/scene-graph/instances/overrides'
import { createDefaultSourceMetadata } from '@open-pencil/scene-graph/node-defaults'

import { nodeChangeToProps } from '../node-change'
import { numericVariableBindingScales } from '../node-change/variable/bindings'
import {
  recordVariableBindingClaims,
  occurrenceAssignmentScales,
  occurrenceScale
} from './bindings/variables'
import { OVERRIDE_FIELDS, type OverrideField, type RawOverrideField } from './fields'
import { resolveOccurrencePath } from './interpret'
import type { InstanceOccurrence } from './occurrence/types'
import { symbolDataOf } from './types'

function occurrenceMetadata(
  current: InstanceOccurrence,
  converted: ReturnType<typeof nodeChangeToProps>
) {
  const metadata = createDefaultSourceMetadata()
  // Figma's own sibling key, so re-export keeps the order Figma saved.
  metadata.orderKey = current.properties.parentIndex?.position ?? null
  metadata.fig.layout = converted.source?.fig.layout ?? null
  metadata.fig.uniformScaleFactor = symbolDataOf(current.properties)?.uniformScaleFactor ?? null
  return metadata
}

/**
 * Fields a layer keeps its own: its children, and state written in place, such as its source
 * metadata and its override maps.
 */
const OWN_FIELDS = new Set(['childIds', 'source', 'instanceOverrides'])

/** Maps and sets are written in place, so values holding them are never shared. */
function holdsCollections(value: unknown): boolean {
  if (value instanceof Map || value instanceof Set) return true
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return false
  return Object.values(value).some(holdsCollections)
}

/**
 * A layer inside an instance holds what its component's layer holds unless an override changed
 * it. Each equal value is the component layer's own object rather than a copy, so a design kit's
 * many instances do not each repeat their components' paints, glyphs, and defaults. Values are
 * replaced, never written into, once loaded; loading writes only into fields a layer keeps.
 */
function shareUnchanged(node: SceneNode, source: SceneNode): void {
  for (const field of Object.keys(node)) {
    if (OWN_FIELDS.has(field)) continue
    const value: unknown = Reflect.get(node, field)
    const original: unknown = Reflect.get(source, field)
    if (value === original || value === null || typeof value !== 'object') continue
    if (holdsCollections(value) || !isEqual(value, original)) continue
    Reflect.set(node, field, original)
  }
  // The layer's source metadata is its own, but the layout Figma saved for it is replaced whole,
  // never written into, and nearly always the component layer's.
  const layout = node.source.fig.layout
  const originalLayout = source.source.fig.layout
  if (layout && layout !== originalLayout && isEqual(layout, originalLayout))
    node.source.fig.layout = originalLayout
}

export interface MaterializedInstance {
  root: SceneNode
  /** Occurrence object identity distinguishes repeated uses of a source node. */
  nodes: ReadonlyMap<InstanceOccurrence, SceneNode>
}

/**
 * Materialize an interpreted tree. Population, sync and layout are the caller's to run.
 * Component IDs must refer to existing COMPONENT nodes in the destination graph.
 * Occurrence provenance stays in the returned map, not in fabricated FIG metadata.
 */
/** What an occurrence tree needs beyond the graph it is written into. */
export interface MaterializeInstanceOptions {
  blobs?: Uint8Array[]
  /** Graph ids for occurrences a component definition already materialized. */
  sourceChildren?: ReadonlyMap<InstanceOccurrence, string>
  /** Nodes to update in place rather than create, keyed by occurrence. */
  existingNodes?: ReadonlyMap<InstanceOccurrence, SceneNode>
  /**
   * The id to create a layer under that is a record of its own, not a copy inside an instance:
   * its saved GUID, so it keeps one id across loads. Undefined creates it under a fresh id.
   */
  recordId?: (occurrence: InstanceOccurrence) => string | undefined
}

/** A document or a variable is a resource record, never a node in an expansion. */
function assertMaterializableType(
  nodeType: 'DOCUMENT' | 'VARIABLE' | SceneNode['type']
): asserts nodeType is SceneNode['type'] {
  if (nodeType === 'DOCUMENT' || nodeType === 'VARIABLE') {
    throw new Error(`Cannot materialize ${nodeType} as an instance descendant`)
  }
}

export function materializeInstance(
  graph: SceneGraph,
  parentId: string,
  occurrence: InstanceOccurrence,
  components: ReadonlyMap<string, string>,
  options: MaterializeInstanceOptions = {}
): MaterializedInstance {
  const { blobs = [], sourceChildren = new Map(), existingNodes = new Map(), recordId } = options
  if (!graph.getNode(parentId)) throw new Error('Missing materialization parent')
  const prepared = new Map<InstanceOccurrence, ReturnType<typeof nodeChangeToProps>>()
  const validate = (current: InstanceOccurrence): void => {
    if (prepared.has(current)) throw new Error('Repeated or cyclic instance occurrence')
    const converted = nodeChangeToProps(current.properties, blobs, 'occurrence')
    if (converted.nodeType === 'TEXT' && current.derivedSize) {
      converted.derivedLayout = { width: current.derivedSize.x, height: current.derivedSize.y }
    }
    assertMaterializableType(converted.nodeType)
    const existing = existingNodes.get(current)
    if (
      existing &&
      (graph.getNode(existing.id) !== existing || existing.type !== converted.nodeType)
    ) {
      throw new Error(`Invalid preallocated occurrence ${current.sourceId}`)
    }
    prepared.set(current, converted)
    const sourceChildId = sourceChildren.get(current)
    if (sourceChildId && graph.getNode(sourceChildId)?.type !== converted.nodeType) {
      throw new Error(`Invalid source child for ${current.sourceId}`)
    }
    if (current.mainComponentId !== null) {
      const id = components.get(current.mainComponentId)
      if (!id || graph.getNode(id)?.type !== 'COMPONENT') {
        throw new Error(`Missing materialized component ${current.mainComponentId}`)
      }
    }
    for (const child of current.children) validate(child)
  }
  validate(occurrence)
  const nodes = new Map<InstanceOccurrence, SceneNode>(existingNodes)
  const applyBindingClaims = (
    current: InstanceOccurrence,
    node: SceneNode,
    owner?: SceneNode
  ): void => {
    if (!owner) return
    for (const claim of current.bindingClaims) {
      if (claim.origin === 'assignment' && claim.field === 'visible') {
        setInstanceOverride(owner.instanceOverrides, owner.id, node.id, 'visible', node.visible)
      }
    }
  }
  /** A record of its own takes its saved GUID, and a copy inside an instance a fresh id. */
  const createLayer = (
    current: InstanceOccurrence,
    nodeType: SceneNode['type'],
    parent: string,
    props: Partial<SceneNode>,
    owner: SceneNode | undefined
  ): SceneNode => {
    const id = owner ? undefined : recordId?.(current)
    return id
      ? graph.createNodeWithId(id, nodeType, parent, props)
      : graph.createNode(nodeType, parent, props)
  }
  const create = (current: InstanceOccurrence, parent: string, owner?: SceneNode): SceneNode => {
    const converted = prepared.get(current)
    if (!converted) throw new Error('Missing prepared occurrence')
    const { nodeType, ...props } = converted
    assertMaterializableType(nodeType)
    const metadata = occurrenceMetadata(current, converted)
    const propsWithIdentity = {
      ...props,
      variableAssignmentScales: occurrenceAssignmentScales(current),
      componentScale: occurrenceScale(current),
      variableBindingScales: numericVariableBindingScales(
        props.boundVariables ?? {},
        current.layoutScale ?? 1,
        current.variableBindingScales
      ),
      componentId:
        current.mainComponentId === null
          ? (sourceChildren.get(current) ?? null)
          : components.get(current.mainComponentId),
      source: metadata
    }
    const existing = existingNodes.get(current)
    if (existing && existing.parentId !== parent) {
      throw new Error(`Preallocated occurrence has wrong parent ${current.sourceId}`)
    }
    const node = existing ?? createLayer(current, nodeType, parent, propsWithIdentity, owner)
    if (existing) graph.updateNode(existing.id, propsWithIdentity)
    const sharedSource = graph.getNode(sourceChildren.get(current) ?? '')
    if (sharedSource) shareUnchanged(node, sharedSource)
    nodes.set(current, node)
    if (existing && current !== occurrence && node.type === 'COMPONENT') return node
    applyBindingClaims(current, node, owner)
    const sourceChildId = sourceChildren.get(current)
    if (owner && current.mainComponentId !== null && sourceChildId) {
      setInstanceOverride(
        owner.instanceOverrides,
        owner.id,
        node.id,
        'sourceComponentId',
        sourceChildId
      )
      const sourceChild = graph.getNode(sourceChildId)
      if (sourceChild?.componentId !== node.componentId) {
        setInstanceOverride(
          owner.instanceOverrides,
          owner.id,
          node.id,
          'componentId',
          node.componentId
        )
      }
    }
    const children = current.children.map(
      (child) => create(child, node.id, node.type === 'INSTANCE' ? node : owner).id
    )
    node.childIds = children
    return node
  }
  const root = create(occurrence, parentId)
  recordPropertyClaims(nodes)
  return { root, nodes }
}

/** Whether a raw claim actually carries the scene value its kind maps to. */
function claimApplies(field: OverrideField, value: unknown, target: SceneNode): boolean {
  if (field.kind === 'text')
    return typeof value === 'object' && value !== null && 'characters' in value
  if (field.kind === 'text-style') return Boolean(target.textStyleId)
  return true
}

/**
 * A claimed paint carries its colour alias inside the paint, so the binding of each claimed
 * paint is part of the claim too, an alias or the lack of one: otherwise a later component
 * sync restores the component's binding over a colour the override set.
 */
/** An instance's claim on a layer's paints, which decides the layer's binding only if it wins. */
interface PaintClaim {
  owner: SceneNode
  target: SceneNode
  scene: keyof SceneNode
  paints: unknown
  /** How deep the owner sits among the instances; the outermost owner's claim wins. */
  depth: number
}

function recordPaintBindingClaims(
  { owner, target, scene, paints }: PaintClaim,
  wins: boolean
): void {
  if (!Array.isArray(paints)) return
  const pattern = new RegExp(`^${scene}/(\\d+)/color$`)
  // A binding of a paint past the claimed ones belongs to a paint the claim removed.
  const removed = Object.keys(target.boundVariables).flatMap((key) => {
    const index = Number(pattern.exec(key)?.[1] ?? Number.NaN)
    return index >= paints.length ? [index] : []
  })
  const claimed = [...paints.keys(), ...removed]
  for (const index of claimed) {
    const key = `${scene}/${index}/color`
    const paint: Paint | undefined = paints[index]
    const bound = Boolean(paint?.colorVar?.value?.alias)
    // The layer took the component's binding with its other fields; a winning literal colour drops it.
    if (wins && !bound && key in target.boundVariables) {
      const { [key]: _dropped, ...kept } = target.boundVariables
      target.boundVariables = kept
    }
    setInstanceOverride(
      owner.instanceOverrides,
      owner.id,
      target.id,
      `boundVariables/${key}`,
      bound ? (target.boundVariables[key] ?? null) : null
    )
  }
  if (claimed.length > 0)
    setInstanceOverride(owner.instanceOverrides, owner.id, target.id, 'boundVariables')
}

function recordPropertyClaims(nodes: ReadonlyMap<InstanceOccurrence, SceneNode>): void {
  const paintClaims: PaintClaim[] = []
  const byId = new Map([...nodes.values()].map((node) => [node.id, node]))
  const nesting = (node: SceneNode) => {
    let depth = 0
    for (let id = node.parentId; id && byId.has(id); id = byId.get(id)?.parentId ?? null) depth++
    return depth
  }
  for (const [ownerOccurrence, owner] of nodes) {
    if (owner.type !== 'INSTANCE') continue
    for (const claim of ownerOccurrence.propertyClaims) {
      const targetOccurrence = resolveOccurrencePath(ownerOccurrence, claim.path)
      const target = nodes.get(targetOccurrence)
      if (!target) throw new Error('Unmaterialized property claim target')
      for (const raw of Object.keys(OVERRIDE_FIELDS) as RawOverrideField[]) {
        if (!(raw in claim.properties)) continue
        const field = OVERRIDE_FIELDS[raw]
        if (!claimApplies(field, claim.properties[raw], target)) continue
        for (const scene of field.scene) {
          const value = target[scene]
          setInstanceOverride(
            owner.instanceOverrides,
            owner.id,
            target.id,
            scene,
            structuredClone(value)
          )
        }
        if (field.kind === 'paint') {
          paintClaims.push({
            owner,
            target,
            scene: field.scene[0],
            paints: claim.properties[raw],
            depth: nesting(owner)
          })
        }
      }
      recordVariableBindingClaims(owner, target, claim.properties as NodeChange)
    }
  }
  // Instances nested in one another can claim the same paints; the outermost one's claim wins.
  const winners = new Map<string, number>()
  const key = ({ target, scene }: PaintClaim) => `${target.id} ${String(scene)}`
  for (const claim of paintClaims)
    winners.set(key(claim), Math.min(winners.get(key(claim)) ?? claim.depth, claim.depth))
  for (const claim of paintClaims)
    recordPaintBindingClaims(claim, claim.depth === winners.get(key(claim)))
}
