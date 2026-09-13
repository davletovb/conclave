from pathlib import Path

p = Path("apps/server/src/orchestrator.ts")
s = p.read_text()

broken_concat = 'debateTranscript += "' + "\n\n" + '" + settled.steps'
fixed_concat = r'debateTranscript += "\n\n" + settled.steps'
broken_join = '.join("' + "\n\n" + '");'
fixed_join = r'.join("\n\n");'

if broken_concat not in s:
    raise SystemExit("missing broken debate concat")
s = s.replace(broken_concat, fixed_concat, 1)
if broken_join not in s:
    raise SystemExit("missing broken debate join")
s = s.replace(broken_join, fixed_join, 1)
p.write_text(s)
