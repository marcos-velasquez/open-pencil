import { writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'

import { defineCommand } from 'citty'

import { BUILTIN_IO_FORMATS, IORegistry } from '@open-pencil/core/io'
import { layoutAuthoredNodes } from '@open-pencil/core/layout'
import { prepareGraphFonts } from '@open-pencil/core/text'

import { requireFile } from '#cli/app/client'
import { ok, printError } from '#cli/format'
import { loadDocument, measureTextHeadlessly, populateWholeDocument } from '#cli/headless'

const io = new IORegistry(BUILTIN_IO_FORMATS)

function writableFormatIds(): string[] {
  return io.listWritableFormats().map((format) => format.id)
}

function defaultOutput(file: string, format: string): string {
  const base = basename(file, extname(file))
  return resolve(`${base}.${format.toLowerCase()}`)
}

export default defineCommand({
  meta: { description: 'Convert a document to another writable format' },
  args: {
    file: {
      type: 'positional',
      description: 'Input document file path',
      required: true
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output file path (default: <name>.<format>)',
      required: false
    },
    format: {
      type: 'string',
      alias: 'f',
      description: 'Output format: fig (default: fig)',
      default: 'fig'
    }
  },
  async run({ args }) {
    const format = args.format.toLowerCase()
    const writableFormats = writableFormatIds()
    if (!writableFormats.includes(format)) {
      printError(`Invalid format "${args.format}". Use ${writableFormats.join(', ')}.`)
      process.exit(1)
    }

    const file = requireFile(args.file)
    const graph = await loadDocument(file)
    populateWholeDocument(graph)
    // A document that stores no layout, such as a .pen file, was laid out as it was read, with
    // its text estimated. The output keeps those sizes, so lay it out again with its text
    // measured in its own fonts, as the app and raster export draw it.
    if (io.findReader(file)?.role !== 'native-document') {
      await measureTextHeadlessly()
      const pageIds = graph.getPages(true).map((page) => page.id)
      await prepareGraphFonts(graph, pageIds)
      layoutAuthoredNodes(graph, pageIds)
    }
    const result = await io.writeDocument(format, graph)
    const output = args.output ? resolve(args.output) : defaultOutput(file, format)
    await writeFile(output, result.data as Uint8Array)
    console.log(ok(`Converted ${file} → ${output}`))
  }
})
