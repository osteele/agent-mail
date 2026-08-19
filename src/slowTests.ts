import { test } from "bun:test";

/** The property-based state-machine suites and the daemon-spawning dashboard
 * tests are CPU-bound, and their fixed timeouts were written against an idle
 * machine. This one routinely runs several agent sessions at once, and load
 * averages above 100 are ordinary. At that point the tests do not fail, they
 * time out: a false red on the most subtle logic in the repo, and one that
 * moves from run to run, which is worse than a stable red because it teaches
 * everyone to disregard the suite.
 *
 * Two controls, and one rule:
 *
 * - `AGENT_MAIL_SLOW_TESTS=skip` drops them, for fast iteration on a loaded
 *   machine. They run by default: this repo has no CI yet, so defaulting to
 *   skip would mean nothing ever ran them. Once CI exists it needs no
 *   configuration, since it inherits the default, and a developer opts out
 *   locally rather than CI opting in.
 * - `AGENT_MAIL_SLOW_TEST_TIMEOUT_MS` sets the budget, defaulting high enough
 *   to survive a loaded machine. A timeout should catch a hang, not a busy
 *   box; on an idle machine these finish in seconds regardless of the ceiling,
 *   so a generous default costs nothing.
 *
 * The rule: skipping announces itself. A silent skip would let a green run
 * mean less than it appears to, which is the failure this whole change exists
 * to stop. */

// Sized against observation, not taste: a peer session recorded one of these
// tests taking 116s at load 120. A ceiling below that turns a busy machine
// into a red suite, which is the whole failure being fixed here.
const DEFAULT_TIMEOUT_MS = 180_000;

export const SLOW_TEST_TIMEOUT_MS = readTimeout();

function readTimeout(): number {
  const raw = process.env.AGENT_MAIL_SLOW_TEST_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `AGENT_MAIL_SLOW_TEST_TIMEOUT_MS must be a positive integer, got ${raw}`,
    );
  }
  return parsed;
}

export function slowTestsSkipped(): boolean {
  return process.env.AGENT_MAIL_SLOW_TESTS === "skip";
}

let announced = false;

/** `test`, for a suite that is slow by nature.
 *
 * Supplies the shared timeout when the caller names none, so the budget lives
 * in one place instead of as a literal beside each test. That arrangement let
 * one suite keep bun's 5s default and time out first under load. An
 * explicit timeout or options object still wins. Skipping is opt-in and loud. */
export const slowTest: typeof test = ((...args: Parameters<typeof test>) => {
  const [name, fn, budget] = args;
  const withBudget = [name, fn, budget ?? SLOW_TEST_TIMEOUT_MS] as Parameters<
    typeof test
  >;
  if (!slowTestsSkipped()) return test(...withBudget);
  if (!announced) {
    announced = true;
    console.warn(
      "agent-mail: SKIPPING slow suites (AGENT_MAIL_SLOW_TESTS=skip). " +
        "Property-based and daemon tests did not run; unset it before trusting a green result.",
    );
  }
  return test.skip(...withBudget);
}) as typeof test;
