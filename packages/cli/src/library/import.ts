import { resolve } from 'node:path'

import type { LibraryComponentImporter } from '@open-pencil/core/figma-api'
import { materializeLibraryAsset, type ComponentLibraryRevision } from '@open-pencil/core/library'
import type { SceneGraph } from '@open-pencil/scene-graph'

import { warn } from '#cli/format'
import { loadDocument, populateWholeDocument } from '#cli/headless'
import { bindVariables, libraryRevision, matchVariablesByName } from '#cli/library/source'

/** A library a script may import components from: its ID and its source document. */
export interface LibrarySourceFile {
  id: string
  file: string
}

/** The `<id>=<file>` a command line names a library by. */
export function parseLibrarySource(value: string): LibrarySourceFile {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator === value.length - 1)
    throw new Error(`Name a library as <id>=<file.fig>, not ${value}`)
  return { id: value.slice(0, separator), file: resolve(value.slice(separator + 1)) }
}

/**
 * Imports a library component into `graph` from the first of `libraries` whose source has its
 * key, at the revision that source makes, as `libraries update` brings it, so a later update
 * finds it current. A library is read only once a script imports from it. With `variablesByName`,
 * the library's variables the document has no namesake for are named on stderr, since their
 * layers stay bound to variables the document does not hold.
 */
export function libraryImporter(
  graph: SceneGraph,
  libraries: LibrarySourceFile[],
  { variablesByName = false }: { variablesByName?: boolean } = {}
): LibraryComponentImporter {
  const loaded = new Map<
    string,
    Promise<{ source: SceneGraph; revision: ComponentLibraryRevision }>
  >()
  const load = (library: LibrarySourceFile) => {
    let entry = loaded.get(library.id)
    if (!entry) {
      entry = (async () => {
        const source = await loadDocument(library.file)
        populateWholeDocument(source)
        return { source, revision: await libraryRevision(source, library.id) }
      })()
      loaded.set(library.id, entry)
    }
    return entry
  }
  return async (key) => {
    for (const library of libraries) {
      const { source, revision } = await load(library)
      if (!revision.manifest.assets.some((asset) => asset.key === key)) continue
      const { componentId, componentSetId } = materializeLibraryAsset(graph, revision, key)
      if (variablesByName) {
        const match = matchVariablesByName(graph, source)
        bindVariables(graph, revision, match)
        if (match.unmatched.size > 0)
          console.error(
            warn(`Variables with no match in the document: ${[...match.unmatched].join(', ')}`)
          )
      }
      return componentSetId ?? componentId
    }
    return null
  }
}
