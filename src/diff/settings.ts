/**
 * The numbers that decide a diff's output (`SCHEMA.md` §6.2, `MILESTONES.md`
 * #43).
 *
 * Five values, every one an environment variable with a working default,
 * because §1.10 is categorical: "every value this service reads is an
 * environment variable with a working default", and there is no settings
 * table to put them in.
 *
 * **Three of the five are copied onto every `comparisons` row** — the colour
 * tolerance, the smallest area reported and the cap on regions — and §1.9 says
 * why all three rather than one: "all three are mutable and all three
 * determined the output — snapshotting one and referencing the others would be
 * a record that is half-true". The other two shape the regions rather than
 * decide what counts as changed, and the row's region list already carries
 * their effect in the geometry it records.
 */

/** The five numbers, as one snapshot. */
export interface DiffSettings {
  /**
   * How different two pixels must be before either counts as changed, from 0
   * to 1. **The comparison library's own default**, which §6.2 argues is "a
   * better starting position than a number invented here precisely because it
   * is not one".
   */
  readonly colourTolerance: number;
  /**
   * The smallest region reported, in **square pixels of area** — not in either
   * side's length.
   *
   * §6.2 and #41 both say why, and it is the mistake this number is most
   * likely to be re-introduced as: a filter on the shorter side discards a
   * one-pixel line across a wide page, which is exactly a border, an
   * underline, a focus ring or a rule — the changes most worth catching. The
   * thin-line allowance in `regions.ts` is the other half of the same rule.
   */
  readonly minimumRegionArea: number;
  /** How many regions come back before the result is truncated, smallest first. */
  readonly maximumRegions: number;
  /** How far apart two changed areas stay separate regions, in pixels. */
  readonly regionMergeDistance: number;
  /**
   * Context around a crop, in pixels. §6.2: "a tight box with nothing around
   * it can be genuinely unidentifiable".
   */
  readonly cropPadding: number;
}

interface NumberDeclaration {
  readonly key: string;
  readonly fallback: number;
  readonly integer: boolean;
  readonly minimum: number;
  readonly maximum: number;
  /** What this number is for, in one line, used in the refusal. */
  readonly summary: string;
}

/**
 * The declarations, in the order §6.2 lists them.
 *
 * Written as data rather than as five reads so the walk test that asserts
 * `.env.example` documents every declared variable has something to walk, and
 * so a variable cannot be added to the code without appearing here.
 */
export const DIFF_DECLARATIONS = [
  {
    key: 'BROKER_DIFF_COLOUR_TOLERANCE',
    fallback: 0.1,
    integer: false,
    minimum: 0,
    maximum: 1,
    summary: 'how different two pixels must be before either counts as changed, from 0 to 1',
  },
  {
    key: 'BROKER_DIFF_MINIMUM_REGION_AREA',
    fallback: 64,
    integer: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    summary: 'the smallest region reported, in square pixels of area',
  },
  {
    key: 'BROKER_DIFF_MAXIMUM_REGIONS',
    fallback: 12,
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    summary: 'how many regions come back before the result is truncated',
  },
  {
    key: 'BROKER_DIFF_REGION_MERGE_DISTANCE',
    fallback: 8,
    integer: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    summary: 'how far apart two changed areas stay separate regions, in pixels',
  },
  {
    key: 'BROKER_DIFF_CROP_PADDING',
    fallback: 16,
    integer: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    summary: 'context around a crop, in pixels',
  },
] as const satisfies readonly NumberDeclaration[];

/** Every variable this feature declares. The walk test reads this. */
export const DECLARED_DIFF_VARIABLES: readonly string[] = DIFF_DECLARATIONS.map((d) => d.key);

/** The defaults, as one snapshot, for anything that needs them without an environment. */
export const DEFAULT_DIFF_SETTINGS: DiffSettings = {
  colourTolerance: 0.1,
  minimumRegionArea: 64,
  maximumRegions: 12,
  regionMergeDistance: 8,
  cropPadding: 16,
};

/**
 * Raised when a variable is set to something that is not the number it
 * declares.
 *
 * A plain `Error` rather than one of the service's refusal classes, and the
 * reason is a dependency direction worth keeping: this module is arithmetic
 * over five numbers and nothing else in it reaches the service layer. The
 * caller that reads settings is what decides whether a bad value refuses the
 * spawn or refuses the call, and it has both classes available.
 */
export class DiffSettingError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = 'DiffSettingError';
    this.key = key;
  }
}

function readNumber(declaration: NumberDeclaration, raw: string | undefined): number {
  if (raw === undefined) {
    return declaration.fallback;
  }
  // Set-and-blank is a value somebody wrote and meant something by, and no
  // number is the one thing it cannot mean. Falling back silently would run a
  // configuration nobody chose.
  if (raw.trim() === '') {
    throw new DiffSettingError(
      declaration.key,
      `${declaration.key} is set but empty. Expected ${declaration.summary}; unset it to use ${String(declaration.fallback)}.`,
    );
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new DiffSettingError(
      declaration.key,
      `${declaration.key} is set to ${JSON.stringify(raw)}, which is not a number. Expected ${declaration.summary}.`,
    );
  }
  if (declaration.integer && !Number.isInteger(value)) {
    throw new DiffSettingError(
      declaration.key,
      `${declaration.key} is set to ${JSON.stringify(raw)}, which is not a whole number. Expected ${declaration.summary}.`,
    );
  }
  if (value < declaration.minimum || value > declaration.maximum) {
    throw new DiffSettingError(
      declaration.key,
      `${declaration.key} is set to ${JSON.stringify(raw)}, which is outside ${String(declaration.minimum)} to ${String(declaration.maximum)}. Expected ${declaration.summary}.`,
    );
  }
  return value;
}

/**
 * Take the snapshot, from the environment §6.3 already read once per process.
 */
export function readDiffSettings(env: NodeJS.ProcessEnv = process.env): DiffSettings {
  const read = (key: string): number => {
    const declaration = DIFF_DECLARATIONS.find((d) => d.key === key);
    if (declaration === undefined) {
      throw new Error(`${key} is read but not declared`);
    }
    return readNumber(declaration, env[key]);
  };

  return {
    colourTolerance: read('BROKER_DIFF_COLOUR_TOLERANCE'),
    minimumRegionArea: read('BROKER_DIFF_MINIMUM_REGION_AREA'),
    maximumRegions: read('BROKER_DIFF_MAXIMUM_REGIONS'),
    regionMergeDistance: read('BROKER_DIFF_REGION_MERGE_DISTANCE'),
    cropPadding: read('BROKER_DIFF_CROP_PADDING'),
  };
}
