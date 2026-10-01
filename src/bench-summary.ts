/**
 * Latest A/B bench summary, surfaced next to the live metrics.
 *
 * `bench/run.ts` writes this file; the dashboard and the stats route read it so
 * a number on the dashboard can always be traced to a labelled run instead of
 * being asserted by the dashboard itself.
 * @module dsh-jev/bench-summary
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface BenchSummary {
  ranAt?: string
  offline?: boolean
  total: number
  correct: number
  accuracy: number
  falsePositives: number
  falseNegatives: number
  latencyMeanMs?: number
  estimatedCostUsd?: number
}

export const DEFAULT_BENCH_SUMMARY_PATH = join(homedir(), '.dsh', 'jev-bench.json')

/**
 * Read the last bench summary.
 * @returns the summary, or undefined when the file is missing or unusable.
 */
export function readBenchSummary(path: string = DEFAULT_BENCH_SUMMARY_PATH): BenchSummary | undefined {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BenchSummary>
    if (typeof parsed?.total !== 'number' || typeof parsed?.correct !== 'number') return undefined
    return {
      ranAt: typeof parsed.ranAt === 'string' ? parsed.ranAt : undefined,
      offline: parsed.offline === true,
      total: parsed.total,
      correct: parsed.correct,
      accuracy: typeof parsed.accuracy === 'number' ? parsed.accuracy : parsed.correct / Math.max(1, parsed.total),
      falsePositives: typeof parsed.falsePositives === 'number' ? parsed.falsePositives : 0,
      falseNegatives: typeof parsed.falseNegatives === 'number' ? parsed.falseNegatives : 0,
      latencyMeanMs: typeof parsed.latencyMeanMs === 'number' ? parsed.latencyMeanMs : undefined,
      estimatedCostUsd: typeof parsed.estimatedCostUsd === 'number' ? parsed.estimatedCostUsd : undefined,
    }
  } catch {
    return undefined
  }
}

/** One-line rendering for the dashboard card. */
export function renderBenchLine(summary: BenchSummary | undefined): string {
  if (!summary) {
    return 'A/B benchmark: no records yet (run `pnpm run bench` to generate)'
  }

  const when = summary.ranAt ? summary.ranAt.replace('T', ' ').slice(0, 19) : 'unknown time'

  return (
    `A/B benchmark (${summary.offline ? 'offline replay' : 'live API'} · ${when}): ` +
    `${summary.correct}/${summary.total} correct (accuracy ${(summary.accuracy * 100).toFixed(1)}%), ` +
    `false positives ${summary.falsePositives}, false negatives ${summary.falseNegatives}` +
    (typeof summary.latencyMeanMs === 'number' ? `, mean latency ${summary.latencyMeanMs}ms` : '')
  )
}
