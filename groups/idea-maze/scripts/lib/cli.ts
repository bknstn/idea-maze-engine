export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

export function getOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];

  const prefix = `${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

export function getPositional(index: number): string | undefined {
  return process.argv.slice(2).filter((arg) => !arg.startsWith('--'))[index];
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
