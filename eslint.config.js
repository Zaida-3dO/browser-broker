// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint, flat config.
 *
 * The type-aware preset is on deliberately rather than for thoroughness:
 * `MILESTONES.md`'s build-rule table asks for source checks and import
 * and call-graph checks (`db.import_isolated`, `arbitration.no_browser_io`,
 * `capture.no_diff_dependency`), and type-aware rules plus restricted-import
 * rules are where those land. Row #3 builds the plumbing; the rules
 * themselves belong to the rows that have code to check.
 *
 * No import allowlist is declared here yet, and the omission is the point.
 * `src/service/` and `src/browser/` hold no modules, so a rule saying only
 * the service layer may reach the store would assert over an empty set —
 * which `MILESTONES.md` names outright as the failure that "passes forever
 * and silently". The directories exist so the rule has stable names to
 * allow when there is something to check.
 */
export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test files.
    //
    // `node --test` takes ownership of the promise its `test()` returns: it
    // awaits every one and fails the run on a rejection. So a call left
    // unawaited here is the documented way to use the runner rather than a
    // dropped promise, and the rule that catches dropped promises cannot tell
    // the two apart. Narrowed to the test glob so application code keeps it.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    // The hygiene gate and its self-test run on a tree with nothing
    // installed, so they are plain JavaScript with no project to type
    // against. Lint them untyped rather than pulling them into the
    // program.
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
);
