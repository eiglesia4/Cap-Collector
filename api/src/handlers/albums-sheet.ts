// GET /albums/{albumId}/sheets/{sheet} — one sheet with its occupied pockets, one GSI1 query (openapi.yaml SheetView,
// data-model.md GSI1 `LOC#<albumId>#<sheet>`, CAP-49).
import { AlbumSheetPath, sheetView } from '../lib/albums.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: AlbumSheetPath }, async (req) =>
  ok(await sheetView({ repos: getRepositories() }, req.uid, req.path.albumId, req.path.sheet)),
);
