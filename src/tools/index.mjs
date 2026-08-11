// The tool registry — this is literally what the model is handed each turn.

import { disk_overview, folder_breakdown, find_junk, find_files } from './scan.mjs';
import { search_content, read_file, list_directory } from './search.mjs';
import { find_duplicates } from './dupes.mjs';
import { propose_changes } from './mutate.mjs';

const S = (type, description, extra = {}) => ({ type, description, ...extra });

export const TOOLS = [
  {
    name: 'disk_overview',
    description:
      'Get free/used space for every drive plus the size of the standard user folders. Cheap and fast. Start here for any "my storage is full" question.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: disk_overview,
    mutating: false,
  },
  {
    name: 'folder_breakdown',
    description:
      'Show which subfolders inside a path consume the most space, plus the largest individual files. Use after disk_overview to drill into the actual culprit. Results are cached for 10 minutes.',
    parameters: {
      type: 'object',
      properties: {
        path: S('string', 'Folder or drive to analyse, e.g. "C:\\Users\\Me" or "D:\\".'),
        depth: S('integer', 'How many levels of subfolder to report. 1 = immediate children. Default 1.'),
        top: S('integer', 'How many rows to return. Default 20.'),
        include_noise: S('boolean', 'Descend into node_modules/.git/caches instead of collapsing them. Default true for storage analysis.'),
      },
      required: ['path'],
    },
    handler: folder_breakdown,
    mutating: false,
  },
  {
    name: 'find_junk',
    description:
      'Locate reclaimable space: temp folders, browser caches, package-manager caches, crash dumps, stale installers in Downloads. Each result carries a risk rating and an explanation. Reports only — deletes nothing.',
    parameters: {
      type: 'object',
      properties: { scope: S('string', '"user" (default) or "system".', { enum: ['user', 'system'] }) },
      required: [],
    },
    handler: find_junk,
    mutating: false,
  },
  {
    name: 'find_files',
    description:
      'Find files by name, extension, size and modification date. This searches an index of every file under the path, so it sees things Windows Search misses. Use for "big files", "old downloads", "all my invoices" style questions. For searching INSIDE file contents use search_content instead.',
    parameters: {
      type: 'object',
      properties: {
        path: S('string', 'Folder to search under. Defaults to the user home folder.'),
        name_contains: S('string', 'Substring that must appear in the filename.'),
        name_glob: S('string', 'Filename glob, e.g. "invoice*.pdf" or "*.{jpg,png}".'),
        extensions: S('array', 'Restrict to these extensions, e.g. ["pdf","docx"].', { items: { type: 'string' } }),
        modified: S('string', 'Date filter. Accepts "2018", "2018-03", "last year", "past 6 months", "today", or an ISO date.'),
        min_size_mb: S('number', 'Only files at least this many MB.'),
        max_size_mb: S('number', 'Only files at most this many MB.'),
        sort_by: S('string', 'Ordering of results.', { enum: ['size', 'newest', 'oldest', 'name'] }),
        limit: S('integer', 'Max rows to return. Default 100, cap 500.'),
        include_noise: S('boolean', 'Search inside node_modules/.git/caches too. Default false.'),
      },
      required: [],
    },
    handler: find_files,
    mutating: false,
  },
  {
    name: 'search_content',
    description:
      'Search INSIDE file contents, including .docx, .pdf, .xlsx, .pptx, .txt, .md, .csv and source code. Combine with a `modified` date filter and `extensions` to answer things like "documents from 2018 containing the word hello". This actually opens and parses each file, so always narrow with filters first.',
    parameters: {
      type: 'object',
      properties: {
        path: S('string', 'Folder to search under. Defaults to the user home folder.'),
        query: S('string', 'The text to look for.'),
        regex: S('boolean', 'Treat `query` as a regular expression. Default false.'),
        case_sensitive: S('boolean', 'Default false.'),
        whole_word: S('boolean', 'Match whole words only. Default false.'),
        file_type: S('string', 'Shorthand for a common set of extensions.', { enum: ['documents', 'any'] }),
        extensions: S('array', 'Restrict to these extensions, e.g. ["docx","pdf"].', { items: { type: 'string' } }),
        modified: S('string', 'Date filter — "2018", "2018-03", "last year", "past 6 months", or an ISO date.'),
        limit: S('integer', 'Max matching files to report. Default 50.'),
        max_files_to_open: S('integer', 'Safety cap on how many files to read. Default 6000.'),
        include_noise: S('boolean', 'Search inside node_modules/.git too. Default false.'),
      },
      required: ['query'],
    },
    handler: search_content,
    mutating: false,
  },
  {
    name: 'read_file',
    description:
      'Read the text of one specific file, including .docx/.pdf/.xlsx. Use to confirm a file really is what you think before proposing to move or delete it.',
    parameters: {
      type: 'object',
      properties: {
        path: S('string', 'Full path to the file.'),
        max_chars: S('integer', 'How much text to return. Default 4000.'),
        offset: S('integer', 'Character offset to start from, for paging through a long document.'),
      },
      required: ['path'],
    },
    handler: read_file,
    mutating: false,
  },
  {
    name: 'list_directory',
    description: 'List the immediate contents of one folder with sizes and dates. Use to orient yourself before a deeper scan.',
    parameters: {
      type: 'object',
      properties: {
        path: S('string', 'Folder to list.'),
        limit: S('integer', 'Max entries. Default 200.'),
      },
      required: ['path'],
    },
    handler: list_directory,
    mutating: false,
  },
  {
    name: 'find_duplicates',
    description:
      'Find byte-identical duplicate files, verified by hashing full contents (not just name or size). Returns groups with a suggested copy to keep. Great for "why is my Pictures folder so big".',
    parameters: {
      type: 'object',
      properties: {
        path: S('string', 'Folder to search under.'),
        min_size_mb: S('number', 'Ignore files smaller than this. Default 1 MB — lower it for documents.'),
        extensions: S('array', 'Restrict to these extensions.', { items: { type: 'string' } }),
        limit: S('integer', 'Max duplicate groups to report. Default 40.'),
        include_noise: S('boolean', 'Include node_modules/.git. Default false.'),
      },
      required: ['path'],
    },
    handler: find_duplicates,
    mutating: false,
  },
  {
    name: 'propose_changes',
    description:
      'Stage file changes for the user to approve. This does NOT change anything — it builds a reviewed plan that appears in the approval panel, and the user decides. Deletions go to the Recycle Bin and moves are undoable. Always verify a file with read_file or find_files before proposing to remove it, and explain your reasoning in each operation\'s `reason` field.',
    parameters: {
      type: 'object',
      properties: {
        summary: S('string', 'One line describing the whole plan, e.g. "Clear 3.2 GB of browser and temp caches".'),
        operations: S('array', 'The operations to stage.', {
          items: {
            type: 'object',
            properties: {
              action: S('string', 'What to do.', { enum: ['recycle', 'move', 'rename', 'copy', 'create_folder'] }),
              path: S('string', 'The file or folder to act on. Not needed for create_folder.'),
              destination: S('string', 'Target folder for move/copy, or the folder to create.'),
              new_name: S('string', 'New filename for rename (name only, no path).'),
              reason: S('string', 'Why this specific file. Shown to the user in the approval panel.'),
            },
            required: ['action'],
          },
        }),
      },
      required: ['summary', 'operations'],
    },
    handler: propose_changes,
    mutating: true,
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Schema-only view, for sending to the model. */
export function toolSchemas() {
  return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}
