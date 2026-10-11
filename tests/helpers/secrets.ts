import { repositoryFile } from './paths.ts';

/**
 * The argument vector that runs the fake secret resolver
 * (`tests/fixtures/fake-secret-resolver.ts`), binding every secret it knows to
 * `origins`.
 *
 * The program is this Node binary, named by its own path, so the command runs
 * the same way on every platform without a shell or a shim.
 */
export function fakeResolverCommand(origins: readonly string[]): string[] {
  return [
    process.execPath,
    repositoryFile('tests', 'fixtures', 'fake-secret-resolver.ts'),
    '--origins',
    origins.join(','),
  ];
}
