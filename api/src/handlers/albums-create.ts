// POST /albums — create an album/box/frame from `AlbumInput`; 409 when its letter is taken (openapi.yaml /albums,
// physical-link.md § The album: GRANDE 6 × 7 defaults, CAP-49).
import { AlbumInput } from '@capcollector/shared';

import { createAlbum } from '../lib/albums.js';
import { created, defineHandler } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, body: AlbumInput }, async (req) =>
  created(await createAlbum({ repos: getRepositories() }, req.uid, req.body)),
);
