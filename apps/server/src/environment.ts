export function readEnvironment(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string,string|undefined> } }).process?.env?.[name];
}
