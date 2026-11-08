// PATCH /albums/{albumId} — rename, resize or set pocket/pitch mm; 409 when shrinking below an occupied pocket or
// renaming an album that holds caps (openapi.yaml /albums/{albumId}, CAP-49).
import { AlbumIdPath, AlbumPatchBody, patchAlbum } from '../lib/albums.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: AlbumIdPath, body: AlbumPatchBody }, async (req) =>
  ok(await patchAlbum({ repos: getRepositories() }, req.uid, req.path.albumId, req.body)),
);
