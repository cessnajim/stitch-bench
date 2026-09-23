# One implementation, driven through the page

The stitcher exists once, in `stitch-bench.html`. The test suite and the MCP server both drive that
page in headless Chrome rather than importing a library, so there is no second implementation to
drift from the first. The obvious alternative, extracting the core into a module that the page and
the server both import, buys speed and a cleaner test seam at the cost of the property that matters
most here: what an agent stitches and what the browser stitches are the same code, verified the same
way.

## Consequences

Every entry point pays a browser launch. An MCP stitch of two dozen full-resolution frames takes
minutes, which is why the server reports progress rather than sitting silent, and why a machine
without Chrome or Chromium can run neither the tests nor the server (hence `CHROME_PATH`).

The page is the interface. Anything the tests or the server need must be reachable from the page,
not from an internal function, and a capability added for the MCP server alone still belongs there.
