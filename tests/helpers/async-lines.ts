/**
 * A fixed set of lines, as the asynchronous iterable a session reads.
 *
 * The session loop's input is asynchronous because a real standard input is.
 * A test supplying lines it already has in memory has nothing to wait for, so
 * this **adapts a value to the shape** rather than declaring an asynchronous
 * generator that never awaits anything — which is a function whose signature
 * promises something its body cannot do.
 */
export function asyncLines(...lines: readonly string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: () => {
          if (index >= lines.length) {
            return Promise.resolve({ done: true as const, value: undefined });
          }
          const value = lines[index] ?? '';
          index += 1;
          return Promise.resolve({ done: false as const, value });
        },
      };
    },
  };
}
