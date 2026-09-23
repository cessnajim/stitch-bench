#!/usr/bin/env python3
"""Download assets by id into a folder ready for stitch-bench.

    DAM_MCP_URL=... python3 fetch_burst.py --out ./frames <asset-id> [<asset-id> ...]
    DAM_MCP_URL=... python3 fetch_burst.py --out ./frames --preview <asset-id> ...

--preview fetches the DAM's smaller preview instead of the original, which is the way through a
gateway that caps inline downloads.
"""
import argparse, os, dam_mcp

ap = argparse.ArgumentParser()
ap.add_argument('ids', nargs='+')
ap.add_argument('--out', default='./frames')
ap.add_argument('--preview', action='store_true')
a = ap.parse_args()

dam_mcp.connect()
os.makedirs(a.out, exist_ok=True)
tool = 'immich_assets_download_thumbnail' if a.preview else 'immich_assets_download_original'
for i, aid in enumerate(a.ids, 1):
    meta = dam_mcp.tool('immich_assets_get', {'id': aid}).get('result', {})
    name = meta.get('originalFileName') or (aid + '.jpg')
    r = dam_mcp.call('tools/call', {'name': tool, 'arguments': {'id': aid}})
    blobs = dam_mcp.images(r)
    if not blobs:
        print(f'{i:3d}. {name}: no image returned (over the gateway inline limit? try --preview)')
        continue
    path = os.path.join(a.out, name)
    open(path, 'wb').write(blobs[0])
    print(f'{i:3d}. {name}  {len(blobs[0]) / 1e6:.1f} MB')
