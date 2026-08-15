# Vercel CLI quirks (non-interactive / spawned from Node)

When driving `vercel` from a server or script (no interactive TTY), four traps:

1. **`.cmd` shim resolution.** On Windows `vercel` is a `.cmd` shim under
   `%APPDATA%/npm/vercel`. Raw `child_process.spawn('vercel', ...)` fails with
   `ENOENT` because Node does not apply PATHEXT. Fix: spawn through the shell —
   `spawn('cmd', ['/c', 'vercel', ...args])` (or invoke `vercel.cmd` explicitly).
   Same applies to `hermes` and any npm-global shim.

2. **Table goes to STDERR.** `vercel project ls` (and similar list commands)
   print the results table on **stderr**, not stdout, when there is no TTY.
   Capturing only stdout yields an empty string and zero parsed rows. Fix: merge
   both streams (`p.stderr.on('data', d => { buf += d; })`) before parsing.

3. **`--yes` rejected in v57** for `project ls` ("unknown or unexpected option:
   --yes"). Drop the flag.

4. **Fixed-width, not delimited.** Output is space-padded fixed columns, not
   tab/space separated. Regex `\S+` splitting breaks it. Parse by slicing:
   `name = line.slice(1,35)`, `url = line.slice(35,90)`,
   `updated = line.slice(90,100)`. Re-verify the slice widths against a fresh
   `vercel project ls` dump before trusting them — column positions shift
   between CLI versions.

Verification: `vercel whoami` prints the account; `vercel project ls` lists
projects under the active team (observed: `jasons-projects-1d845fc4`).
