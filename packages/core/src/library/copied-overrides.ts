import type { SceneGraph } from '@open-pencil/scene-graph'
import { remapInstanceOverrideState } from '@open-pencil/scene-graph/instances/overrides'

/**
 * Points a copied instance's overrides at the copies `mappedIds` made: they name the layers they
 * change, and the components they swap in, by the IDs of the layers that were copied. Variable
 * IDs stay as they are, since the copies keep their source's variables.
 */
export function remapCopiedInstanceOverrides(
  graph: SceneGraph,
  nodeId: string,
  mappedIds: ReadonlyMap<string, string>
): void {
  const overrides = graph.getNode(nodeId)?.instanceOverrides
  if (!overrides || (overrides.self.size === 0 && overrides.descendants.size === 0)) return
  graph.updateNode(nodeId, {
    instanceOverrides: remapInstanceOverrideState(overrides, {
      node: (id) => mappedIds.get(id) ?? id,
      variable: (id) => id
    })
  })
}
