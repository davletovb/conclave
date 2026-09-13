from pathlib import Path

branch_root = Path('.')

orch = branch_root / 'apps/server/src/orchestrator.ts'
text = orch.read_text()
old = '''function isRetryableStepError(error: unknown) {\n  const message = errorMessage(error);\n'''
new = '''function isRetryableStepError(error: unknown) {\n  if (isRateLimitError(error)) return false;\n  const message = errorMessage(error);\n'''
if old not in text:
    raise SystemExit('retry classifier target not found')
orch.write_text(text.replace(old, new, 1))

test = branch_root / 'apps/server/src/orchestrator.test.ts'
text = test.read_text()
old = '''class RateLimitedProvider extends MockProvider {\n  override async generate(request: ProviderRequest) {\n    if (request.model) throw new Error("Rate limit exceeded; try again later");\n    return super.generate(request);\n  }\n}\n'''
new = '''class RateLimitedProvider extends MockProvider {\n  calls = 0;\n\n  override async generate(request: ProviderRequest) {\n    this.calls += 1;\n    if (request.model) throw new Error("Too many requests; try again later");\n    return super.generate(request);\n  }\n}\n'''
if old not in text:
    raise SystemExit('rate limited provider target not found')
text = text.replace(old, new, 1)
old = '''      participants: [participants[0]],\n    }, {\n      runId: "limit-test",\n'''
new = '''      participants: [participants[0]],\n      budget: { maxCalls: 2, maxRounds: 1 },\n    }, {\n      runId: "limit-test",\n'''
if old not in text:
    raise SystemExit('rate limit budget target not found')
text = text.replace(old, new, 1)
old = ''')).rejects.toThrow(/rate limit/i);\n\n    const notice = events.find'''
new = ''')).rejects.toThrow(/too many requests/i);\n\n    const notice = events.find'''
if old not in text:
    raise SystemExit('rate limit error expectation target not found')
text = text.replace(old, new, 1)
old = '''    const notice = events.find((event): event is Extract<OrchestrationStreamEvent, { type: "rate_limit" }> => event.type === "rate_limit");\n    expect(notice?.notice).toMatchObject({ provider: "mock", model: "mock-gpt", stepId: "answer-1" });\n'''
new = '''    const notice = events.find((event): event is Extract<OrchestrationStreamEvent, { type: "rate_limit" }> => event.type === "rate_limit");\n    expect(notice?.notice).toMatchObject({ provider: "mock", model: "mock-gpt", stepId: "answer-1" });\n    expect(limited.calls).toBe(1);\n    expect(events.some(event => event.type === "step_retrying")).toBe(false);\n'''
if old not in text:
    raise SystemExit('rate limit assertion target not found')
test.write_text(text.replace(old, new, 1))
