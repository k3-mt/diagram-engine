# Trying it for real

A first session, start to finish. About ten minutes.

The point of this file is that the engine is driven by **talking**, not by typing commands.
The commands below exist so you can see what the agent is doing and check its work — in
normal use you run two of them (`init`, `serve`) and then never touch the CLI again.

---

## 1. Install it

The quickest route installs nothing on your machine:

```bash
claude plugin marketplace add k3-mt/diagram-engine
claude plugin install diagram@diagram-engine
```

That gives you the tools, the rules and `/diagram-serve`. The commands below use the
`diagram` CLI to check the agent's work, and the CLI comes from the source install:

```bash
cd /path/to/diagram-engine
npm install
npm run build
npm link              # puts `diagram` on your PATH
diagram --version     # confirm
```

## 2. Set up a project

Any directory. It does not need to be a codebase — a scratch folder is fine for a first go.

```bash
cd ~/somewhere
diagram init          # writes .mcp.json, .gitignore, agent rules, a Claude Code skill
diagram serve         # opens http://localhost:4400 and stays running
```

On a plugin install, `init` writes only `.diagram/` and the `.gitignore` block — the
plugin already ships the rest — and `/diagram-serve` opens the viewer, so neither
command is strictly needed.

Leave `serve` running in its own terminal. It watches the document on disk and repaints the
browser when it changes. It has no opinion about who changed it.

## 3. Start your agent and talk

In a **second** terminal, in the same directory:

```bash
claude
```

It picks up the MCP server from `.mcp.json` on launch. Now describe a system in ordinary
prose. Paste something like this:

> We run a React web app and an iOS client. Both call an API gateway. The gateway routes to
> an auth service and an orders service. Auth reads a Postgres users table. Orders reads
> Postgres and publishes order events to Kafka. A fulfilment worker consumes those events
> and writes to S3.

The diagram appears in the browser. That is the whole product; everything below is either
refinement or verification.

## 4. Things worth trying, roughly in order of what they teach you

**Add a boundary.** *"Put postgres, kafka and the fulfilment worker in a private VPC."*
Watch the container form around the nodes that are already there. Nothing should jump —
node ids from the first turn survive, which is what keeps the layout stable across turns.

**Force a crossing.** *"Add a redis cache that orders and auth both read from."* Look for
the little arc where one line hops over another instead of ambiguously overlapping.

**Switch audience.** Press `[exec]` in the status bar. Boundaries collapse to single boxes
and the edges merge with counts (`×3`). Press `[eng]` to open everything again. These
buttons are local to your browser — they never write the document.

**Ask what breaks.** In the terminal:

```bash
diagram analyse
diagram blast-radius postgres
```

`analyse` ranks chokepoints, synchronous chains and cycles. `blast-radius` says what is at
risk if a component dies, and what is *contained* behind an asynchronous edge. Both always
print what they do **not** know — how much of the diagram carries no operational data — and
both say "at risk", never "will fail".

**Then do it in the viewer.** Press `[blast]` and click a node. Shift-click to knock out
several at once and watch the at-risk set grow.

**Tell it about redundancy.** *"Actually postgres has a read replica — orders can use
either."* That is one edit to the existing edges, not a redraw, and blast radius stops
claiming the loss of one replica takes orders down. Redundancy is only ever recorded when
you say it; the agent will not infer it from code, because a wrongly-assumed replica hides
a real single point of failure.

**Point it at real code.** In a repository: *"Read the docker-compose.yml and add anything
I missed."* Then check its homework:

```bash
diagram check --bindings
```

Every citation the agent recorded is resolved against the filesystem. An invented one does
not survive this, which is the point — it exits non-zero, so it can run in CI.

## 5. If something looks wrong

**The diagram contradicts what you said.** Say so plainly — *"no, the worker reads from the
queue, not the other way round"*. Corrections are ordinary turns.

**An arrow looks backwards.** Read the edge aloud as a sentence: *`orders reads postgres`*.
The arrow points at the **dependency** — the thing you would break by removing. Data often
flows the other way, and that is expected. If it does not read as a sentence, it is wrong,
and saying so will fix it.

**Nothing appears in the browser.** Check the dot in the status bar. Green is connected;
amber or red means `serve` is not running or the document failed to parse. `diagram check`
will tell you which.

**It invented something.** That is a real bug and worth reporting — the rules forbid it and
it is measured against two reference systems on every change. A hostname in a README is
prose, not a component.

## 6. What it will not do

Mouse editing — you cannot drag, resize or reparent anything. The layout engine owns
geometry, and the model never emits coordinates. Past roughly sixty nodes it gets hard to
read; use `focus` or collapse.

---

`docs/spec.md` is the full specification, including the parts that are specced but
deliberately unbuilt. `packages/core/rules.md` is the text that governs how the agent
draws — in an architecture with no system prompt, that file *is* the prompt.
