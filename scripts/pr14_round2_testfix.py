from pathlib import Path

p = Path("apps/server/src/orchestrator.test.ts")
s = p.read_text()
old = 'request.model === "mock-grok" && latest.includes("debate round 1")'
new = 'request.model === "mock-grok" && latest.startsWith("You are in debate round 1.")'
if old not in s:
    raise SystemExit("missing debate round-one fixture target")
p.write_text(s.replace(old, new, 1))
