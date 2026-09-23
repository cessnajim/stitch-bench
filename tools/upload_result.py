#!/usr/bin/env python3
"""Upload a finished panorama back to the DAM, with provenance in its description.

    DAM_MCP_URL=... python3 upload_result.py pano.jpg --album "Stitched Panoramas" \
        --taken 2026-09-18T20:25:21Z --lat 44.625175 --lon -124.050751 --note "26 frames, 4.6% painted in"

Uses the authorized shared-link route: the gateway hands out a short-lived upload-only URL and the
file goes straight to Immich, so no API key is ever exposed.
"""
import argparse, os, subprocess, urllib.parse, dam_mcp

ap = argparse.ArgumentParser()
ap.add_argument('file')
ap.add_argument('--album', default='Stitched Panoramas')
ap.add_argument('--taken', help='ISO-8601 capture time with Z, e.g. 2026-09-18T20:25:21Z')
ap.add_argument('--lat', type=float)
ap.add_argument('--lon', type=float)
ap.add_argument('--note', default='')
ap.add_argument('--host', help='reachable Immich host:port, if the gateway reports an internal one')
a = ap.parse_args()

dam_mcp.connect()
auth = dam_mcp.tool('immich_assets_upload_authorize', {'albumName': a.album, 'ttlMinutes': 60})
res = auth.get('result') or {}
url = res.get('upload_url')
if not url:
    raise SystemExit(f'authorize failed: {auth}')
if a.host:                       # gateways often report a container-internal hostname
    parts = urllib.parse.urlsplit(url)
    url = urllib.parse.urlunsplit(('http', a.host, parts.path, parts.query, ''))

ts = a.taken or '1970-01-01T00:00:00.000Z'
out = subprocess.run(['curl', '-s', '-X', 'POST', url,
                      '-F', f'assetData=@{a.file}', '-F', 'deviceId=stitch-bench',
                      '-F', f'deviceAssetId={os.path.basename(a.file)}',
                      '-F', f'fileCreatedAt={ts}', '-F', f'fileModifiedAt={ts}'],
                     capture_output=True, text=True).stdout
print(out)
import json
asset = json.loads(out or '{}').get('id')
if asset and (a.note or a.taken or a.lat is not None):
    patch = {'id': asset}
    if a.note:
        patch['description'] = a.note
    if a.taken:
        patch['dateTimeOriginal'] = a.taken
    if a.lat is not None:
        patch['latitude'], patch['longitude'] = a.lat, a.lon
    print(dam_mcp.tool('immich_assets_update', patch).get('ok'))
