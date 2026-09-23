"""Minimal MCP-over-HTTP client for a self-hosted Immich gateway.

Configure with DAM_MCP_URL (e.g. https://dam.example:8443/mcp) and, when the gateway uses a
private CA, DAM_CA_PEM pointing at the CA file. Nothing here is specific to stitching; it exists
so the other scripts in this folder can find and fetch source frames.
"""
import json, os, subprocess

URL = os.environ.get('DAM_MCP_URL', '')
CA = os.environ.get('DAM_CA_PEM', '')
_session = None


def _curl(args):
    return subprocess.run(['curl', '-s', '-m', '300'] + (['--cacert', CA] if CA else []) + args,
                          capture_output=True, text=True).stdout


def connect():
    """Open an MCP session and enable the read-only tool categories."""
    global _session
    if not URL:
        raise SystemExit('set DAM_MCP_URL to your gateway, e.g. https://dam.example:8443/mcp')
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2024-11-05", "capabilities": {},
        "clientInfo": {"name": "stitch-bench", "version": "1.0"}}})
    head = _curl(['-D', '-', '-o', '/dev/null', '-X', 'POST', URL,
                  '-H', 'Content-Type: application/json',
                  '-H', 'Accept: application/json, text/event-stream', '-d', body])
    for line in head.replace('\r', '').splitlines():
        if line.lower().startswith('mcp-session-id:'):
            _session = line.split(':', 1)[1].strip()
    if not _session:
        raise SystemExit('no MCP session id returned — is the gateway reachable?')
    call('notifications/initialized', {}, notify=True)
    tool('immich_tools_enable', {'categories': ['read', 'search', 'assets']})
    return _session


def call(method, params=None, notify=False):
    body = json.dumps({"jsonrpc": "2.0", **({} if notify else {"id": 1}),
                       "method": method, "params": params or {}})
    out = _curl(['-X', 'POST', URL, '-H', 'Content-Type: application/json',
                 '-H', 'Accept: application/json, text/event-stream',
                 '-H', f'mcp-session-id: {_session}', '-d', body])
    if notify:
        return None
    for line in out.splitlines():
        if line.startswith('data: '):
            msg = json.loads(line[6:])
            if 'result' in msg or 'error' in msg:
                return msg
    raise RuntimeError(out[:300] or 'no response')


def tool(name, args=None):
    """Call a gateway tool and return its parsed payload."""
    r = call('tools/call', {"name": name, "arguments": args or {}})
    if 'error' in r:
        return r['error']
    text = '\n'.join(c.get('text', '') for c in r['result'].get('content', []) if c.get('type') == 'text')
    try:
        return json.loads(text)
    except ValueError:
        return text


def images(r):
    """Binary image parts of a tools/call result."""
    import base64
    return [base64.b64decode(c['data']) for c in r.get('result', {}).get('content', [])
            if c.get('type') == 'image']
