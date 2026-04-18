# Collab (plan)

Git-backed team collaboration for Paper files. Ships inside inkpot as the `collab` subcommand, wrapped by a Claude Code plugin in the same repo.

**Status: plan only.** Nothing here is implemented yet. This doc is the spec to critique and implement against.

**Non-negotiable constraint:** don't break `inkpot pdf` or `inkpot form`. Both are in active use. Any change that touches `src/pdf.js`, `src/form.js`, or their shared optimizers must be additive and tested against a real run first.

## Purpose

A team of 3–10 non-devs (copywriter, strategist, designer) collaborates on a single Paper file's worth of designs. Each person has their own local Paper. A shared git repo is the sync bus. All interactions go through slash commands in Claude Code — no git knowledge, no terminal fluency required.

## Quick start

```sh
# CLI (for devs; also what the Claude plugin wraps)
inkpot collab setup                    # one-time: checks gh auth, Paper MCP
inkpot collab push                     # push every artboard in current Paper to git
inkpot collab pull                     # pull every artboard from git into current Paper
inkpot collab push --only hero         # push a single artboard by name (optional)
inkpot collab pull --only hero

# Claude Code plugin (for non-devs)
/paper-setup                         # wraps `inkpot collab setup`
/paper-push                          # wraps `inkpot collab push`
/paper-pull                          # wraps `inkpot collab pull`
```

## Pipeline flow

### Push

```
 Paper MCP
    │  get_basic_info       → artboard list (including top/left/size)
    │  get_jsx (per artboard)
    ▼
 For each artboard:
   write paper/<name>.html  ← JSX stored natively, with position metadata in a header comment
 ────────────────────────────────────────────────────────────────────
 git add paper/*.html
 git commit -m "paper: push <n> artboards"
 git push
   ├─ success → "pushed <n> artboards"
   └─ rejected (non-fast-forward):
        git fetch
        git reset --soft HEAD^
        git pull --rebase
        identify conflicting files (local vs remote differ)
        for each conflict: render remote → write_html → place as <name>--remote
        ↪ "someone pushed first. resolve on canvas, then run /paper-push again"
```

### Pull

```
 git fetch && git pull --ff-only
   ├─ non-ff (local committed but unpushed): bail with clear message
   └─ success:
        for each paper/<name>.html that differs from what's in local Paper:
           does local Paper's get_jsx match git HEAD's previous version?
             yes (user hasn't edited): clean update
                render → write_html (replace current artboard's content)
             no (user has local edits): CONFLICT
                render remote → place as <name>--remote on canvas
                ↪ "remote version placed beside your local as <name>--remote"
```

### Conflict resolution (UX — human does this in Paper)

```
Canvas has:
   hero            ← local version (untouched)
   hero--remote    ← remote version (dashed red outline, 64px right of hero)

Human action (in Paper, no skill needed):
   option A — keep mine:    delete hero--remote.         next /paper-push commits local.
   option B — keep theirs:  delete hero, rename hero--remote → hero.  next /paper-push commits.
   option C — keep both:    rename hero--remote → hero-v2.  next /paper-push commits both.

`/paper-push` refuses to run while any `--remote` suffixed artboards exist.
Error is plain English: "resolve these first: hero--remote, cta--remote"
```

## Sub-subcommand specs

### `inkpot collab setup`

One-time preflight. Stateless.

1. `gh auth status` — if not authed, instruct user to run `gh auth login`. Don't run it automatically (browser flow; user needs to see it happen).
2. Probe Paper MCP (`get_basic_info`). Exit non-zero if unreachable.
3. Probe `git status` in cwd. Must be a git repo.
4. Probe that the remote is reachable (`git ls-remote origin HEAD`).
5. Print a success summary or the specific missing piece.

No side effects. No files written. Just a readiness check.

Size target: ≤80 lines.

### `inkpot collab push`

1. `git status --porcelain paper/` — fail if there are uncommitted non-inkpot changes that would be swept into the commit. (We only ever touch `paper/<name>.html`; everything else in the repo is untouched.)
2. Connect to Paper MCP, `get_basic_info`.
3. Filter out artboards whose names start with `__verify__` or end with `--remote` (the latter would mean unresolved conflicts; abort with a clear message).
4. For each artboard: `get_jsx`, write `paper/<name>.html` with a header metadata comment (`<!-- paper:artboard {"top":…,"left":…,"width":…,"height":…} -->`), hash the body.
5. If nothing changed since HEAD, exit "no changes to push".
6. `git add paper/<name>.html` for files whose hash changed.
7. `git commit -m "paper: push <n> artboards from <user>"` (user from `git config user.email`).
8. `git push`.
9. On non-fast-forward rejection: run the conflict flow above.

Flags:
- `--only <name>[,<name>...]` — restrict to specific artboards
- `--dry-run` — compute the diff, report what would be pushed, don't commit
- `--mcp-url <url>` — override MCP endpoint

Size target: ≤200 lines including helpers.

### `inkpot collab pull`

1. `git fetch`.
2. Compare `paper/*.html` between local and remote HEAD.
3. For each file that differs:
   - Read the JSX + metadata.
   - Render JSX → HTML using the same React pipeline as `src/pdf.js` (extract to `src/shared/render.js` if needed — see "Implementation order" below).
   - Does an artboard with this name exist in local Paper? (via `get_basic_info`)
     - No: `create_artboard`, `write_html (insert-children)`, `update_styles` to position from metadata.
     - Yes, and local JSX matches the last-pulled version (stored where? see open question): overwrite in place.
     - Yes, and local JSX diverged: create `<name>--remote` artboard at `(metadata.top, metadata.left + metadata.width + 64)`, dashed red outline via `update_styles`.
4. `git pull --ff-only` to advance HEAD (assuming no local commits ahead of remote on `paper/*`).
5. Report: "pulled <n> clean, <m> conflicts placed on canvas".

Open question: how does the pull detect whether the user has local edits? Options:
  - (a) Maintain a local `.inkpot-collab-state.json` caching last-pulled hashes. Violates the "stateless" invariant.
  - (b) Always compute fresh: `get_jsx(artboard)` → hash → compare to `git ls-files paper/<name>.html`'s blob SHA. If they match, no local edits. If not, user has edited.
  - **Prefer (b).** Stays stateless. Aligns with inkpot's design.

Flags: same as push.

Size target: ≤200 lines.

## Storage format

Each committed file at `paper/<name>.html`:

```
<!-- paper:artboard {"top":-1900,"left":-7491,"width":832,"height":1178} -->
(
  <div style={{ backgroundColor: '#FAFAFA', ... }}>
    ...
  </div>
)
```

- **First line is metadata** — a single-line JSON comment with position + size. Regex-parseable; human-readable.
- **Body is JSX as returned by `get_jsx(format: 'inline-styles')`** — stored natively, no transformation. The pull-side renders it via React to HTML before `write_html`.

Rationale: JSX is what Paper emits. Storing it raw means push-side never transforms. Readable diffs in PRs. One render step at pull only.

## Claude plugin (inside inkpot)

```
inkpot/
  .claude-plugin/
    plugin.json                # manifest
  commands/
    paper-setup.md             # body: !inkpot collab setup
    paper-push.md              # body: !inkpot collab push $ARGS
    paper-pull.md              # body: !inkpot collab pull $ARGS
    paper-pdf.md               # body: !inkpot pdf $ARGS          (wraps existing subcommand)
    paper-form.md              # body: !inkpot form $ARGS         (wraps existing subcommand)
  bin/inkpot.js                  # + collab dispatch
  src/
    collab/
      push.js
      pull.js
      setup.js
      shared.js                # conflict detection, metadata parse/emit
    shared/
      mcp.js                   # (new) shared MCP client — extracted from pdf.js if needed
      render.js                # (new) JSX → HTML via React — extracted from pdf.js if needed
    pdf.js                     # unchanged
    form.js                    # unchanged
    optimizeBlooms.js          # unchanged
    optimizeImages.js          # unchanged
    embedRemotes.js            # unchanged
  docs/
    pdf.md                     # unchanged
    form.md                    # unchanged
    collab.md                  # this file
    plugin.md                  # (new) describes the Claude plugin usage
```

### Distribution

Claude plugins can source from npm:

```json
{
  "source": "npm",
  "package": "inkpot"
}
```

So installing the plugin is one line in Claude Code (`/plugin add inkpot` via marketplace or direct npm source). Claude's plugin manager pulls the npm package and registers the commands. Updates flow through npm releases.

### Node prereq

Users need Node ≥20 installed (inkpot is an npm CLI). Document clearly. `/paper-setup` detects missing node and gives the download link.

Not using Bun binaries for distribution — they add CI complexity for ongoing maintenance that outweighs a one-time 2-minute Node install on macOS.

## Flags (all subcommands)

- `--mcp-url <url>` — Paper MCP endpoint override (matches pdf/form)
- `--help, -h` — per-subcommand help
- Root: `inkpot collab --help` lists the three sub-subcommands

## Gotchas & troubleshooting

**"Paper MCP not reachable"** — Paper isn't running. Open Paper, then retry.

**"gh not authed"** — run `gh auth login` and pick GitHub.com → HTTPS → device code.

**"--remote artboards present, push aborted"** — a previous pull placed conflict versions on your canvas. Resolve them (delete or rename per the UX above) before pushing.

**"non-fast-forward push, conflicts placed on canvas"** — someone else pushed between your last pull and now. Look for `--remote` artboards, resolve visually, `/paper-push` again.

**"local Paper has artboards not in git yet"** — normal for first-time push. Just push. Everything gets committed.

**"artboard name has slash/weird chars"** — `paper/<name>.html` may not be a valid path. We'll sanitize names (replace `/` with `__`, collapse whitespace) and warn. Decide the exact scheme during implementation.

**"conflict version doesn't have dashed red outline"** — `update_styles` call failed. Check MCP logs. The conflict artboard is still there, just not visually distinguished; resolution is safe.

## Design invariants

Matching inkpot's existing invariants:

- **Stateless.** No local cache file, no config, no per-machine state outside git + the local Paper file.
- **Paper is the source of truth for content; git is the source of truth for the committed state.** Each side owns one thing.
- **Artboard naming IS the manifest.** No variants, no branches-within-names. `hero` is hero. `hero--remote` is a transient conflict artifact, not a real name.
- **Deterministic.** `get_jsx → file` must be byte-stable across runs. Verified: it is.
- **No writes to non-`paper/` files** (other than git operations). Skills don't touch `README.md`, don't edit `package.json`, don't pollute the repo.

## Dependencies (new)

Nothing new at runtime. `collab` subcommand reuses:

- `@modelcontextprotocol/sdk` — already a inkpot dependency
- `react`, `react-dom` — already devDeps (for pdf); promote to deps if pull needs them at runtime
- Node built-ins: `child_process` (for git/gh), `fs`, `path`, `crypto` (hashing)

No new npm packages. No new binaries. No Bun.

## Implementation order

Sequence matters — safety first.

1. **Scaffold only — don't touch pdf/form.** Add empty `src/collab/push.js`, `src/collab/pull.js`, `src/collab/setup.js`. Wire into `bin/inkpot.js` dispatch. Run `inkpot pdf vp` and `inkpot form <whatever>` to confirm nothing broke. Commit.
2. **Write `src/shared/mcp.js`** — extract MCP connection helpers, without changing `src/pdf.js`'s imports yet (keep pdf.js working, re-export the same names from the new location later). Commit.
3. **Implement `inkpot collab setup`** — small, self-contained, no Paper writes. Test. Commit.
4. **Implement `inkpot collab push`** (happy path only — no conflict handling). Test against a real Paper file. Verify `inkpot pdf` still works. Commit.
5. **Implement `inkpot collab pull`** (happy path only). Test round-trip: push → delete artboard in Paper → pull → artboard reappears. Commit.
6. **Add conflict handling to push.** Simulate by committing a file directly, then pushing a diverging change from Paper. Commit.
7. **Add conflict handling to pull.** Simulate by editing an artboard locally, then pulling a changed version from git. Commit.
8. **Add `.claude-plugin/plugin.json` + `commands/*.md` wrappers.** Test via Claude Code. Commit.
9. **Write `docs/plugin.md`** documenting the plugin install flow. Commit.
10. **Publish `inkpot@0.3.0`** with the collab subcommand and plugin. Update README to mention both.

Every step is independently releasable. If step 8 breaks, roll back without losing the CLI work.

## Verification gates

Before each commit in the order above, run this manually:

```sh
cd /Users/jcwejman/git/@io/paper/inkpot
node bin/inkpot.js pdf vp -o /tmp/verify.pdf     # must succeed
node bin/inkpot.js form asya                      # must succeed (if applicable)
```

Both existing subcommands must continue to work at every step. If either fails, roll back and fix before proceeding.

## Open questions to decide during implementation

1. **Artboard name sanitization rule** — slash, spaces, unicode. Pick a scheme (probably: allow `[a-z0-9-_]`, replace others with `-`, bail on collisions).
2. **How to detect "user has local edits" reliably** — approach (b) in the pull spec (compare live `get_jsx` hash to `git ls-files` blob SHA) is stateless but requires Paper MCP to be reachable during every pull. Acceptable? Probably yes; it's required anyway.
3. **What counts as a "push nothing" scenario** — if the user opened Paper but didn't change anything, should push still run? Probably no-op with a log line. Not worth an error.
4. **Should `/paper-pdf` be in the plugin** (wrapping existing `inkpot pdf`) — yes, for consistency. It's already-working functionality, just surfaced as a slash command.
