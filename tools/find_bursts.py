#!/usr/bin/env python3
"""Find panorama-shaped bursts in a DAM: runs of frames shot within seconds of each other.

    DAM_MCP_URL=... python3 find_bursts.py [--pages 12] [--gap 10] [--min 3]

Prints each burst with its span and filenames. Feed the ones that look like sweeps to
fetch_burst.py.
"""
import argparse, datetime, dam_mcp

ap = argparse.ArgumentParser()
ap.add_argument('--pages', type=int, default=12, help='pages of assets to scan, newest first')
ap.add_argument('--gap', type=float, default=10, help='seconds between frames to stay in one burst')
ap.add_argument('--min', type=int, default=3, help='minimum frames to report')
a = ap.parse_args()

dam_mcp.connect()
rows = []
for page in range(1, a.pages + 1):
    r = dam_mcp.tool('immich_search_metadata', {'type': 'IMAGE', 'size': 500, 'page': page})
    got = r.get('result') or []
    if not got:
        break
    rows += [(x['localDateTime'], x['originalFileName'], x['id'], x.get('city')) for x in got]
    if not r['meta'].get('next'):
        break

t = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
rows.sort(key=lambda r: t(r[0]))
groups, cur = [], [rows[0]]
for prev, row in zip(rows, rows[1:]):
    if (t(row[0]) - t(prev[0])).total_seconds() <= a.gap:
        cur.append(row)
    else:
        groups.append(cur)
        cur = [row]
groups.append(cur)
groups = [g for g in groups if len(g) >= a.min]
print(f'{len(rows)} assets scanned, {len(groups)} bursts of {a.min}+ frames\n')
for g in sorted(groups, key=lambda g: -len(g)):
    span = (t(g[-1][0]) - t(g[0][0])).total_seconds()
    print(f'{len(g):3d} frames  {span:6.1f}s  {g[0][0][:16]}  {g[0][3] or "?":14.14s}  '
          f'{g[0][1]} … {g[-1][1]}')
    print('   ids: ' + ' '.join(x[2] for x in g))
