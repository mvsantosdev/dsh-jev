/**
 * Metrics tracking and telemetry for TypeSafe AI (dsh-jev).
 * Records tool pruning token savings, loop guard interruptions, safety screenings, and latency.
 * @module dsh-jev/metrics
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/**
 * Fallback characters-per-token used only when no token estimator is available.
 * The previous build multiplied a flat 150 tokens per pruned tool and claimed
 * 15000 tokens saved per interrupted loop; neither was measured, so both are gone.
 */
export const FALLBACK_CHARS_PER_TOKEN = 3.5;
function createEmptyMetrics() {
    const now = new Date().toISOString();
    return {
        version: 2,
        firstRecordedAt: now,
        lastUpdatedAt: now,
        toolPruner: {
            evaluations: 0,
            toolsPruned: 0,
            toolsRetained: 0,
            removedSchemaChars: 0,
            estimatedTokensSaved: 0,
            tokenSource: 'heuristic',
        },
        loopGuard: {
            checks: 0,
            interrupted: 0,
            warned: 0,
            notices: 0,
            uncertain: 0,
        },
        safetyGuard: {
            screened: 0,
            blocked: 0,
            approvals: 0,
            warned: 0,
            hardDenied: 0,
            uncertainDenied: 0,
            inspectionRetries: 0,
            inspectionFailures: 0,
        },
        resultShaper: {
            shaped: 0,
            charsRemoved: 0,
        },
        systemOne: {
            totalCalls: 0,
            totalLatencyMs: 0,
            avgLatencyMs: 0,
            errors: 0,
            latencySamples: 0,
            inputBytes: 0,
            estimatedCostUsd: 0,
            cacheHits: 0,
            decisionErrors: 0,
        },
    };
}
/** Environment override for the metrics file, used by verification scripts. */
export const METRICS_PATH_ENV = 'DSH_JEV_METRICS_PATH';
/**
 * Where the collector persists, resolved on first use rather than at import.
 *
 * A script that merely imports the plugins would otherwise construct the
 * collector against the live file and overwrite the very metrics an operator
 * reads to judge a deployment. Resolving late lets a tool point the collector at
 * a scratch file after imports and before its first decision.
 */
export function resolveMetricsPath(explicit) {
    if (explicit !== undefined && explicit.length > 0)
        return explicit;
    const override = typeof process !== 'undefined' ? process.env?.[METRICS_PATH_ENV] : undefined;
    if (override !== undefined && override.length > 0)
        return override;
    return join(homedir(), '.dsh', 'jev-stats.json');
}
/**
 * Merge a persisted snapshot over a fresh default, key by key and section by section.
 *
 * A field added in a later build is absent from files written before it, and returning
 * the stored object verbatim leaves it `undefined`: the dashboard renders "undefined" and
 * the first increment writes `NaN` into the persisted file, which then survives every
 * restart. Observed live - the live file carried the five 0.2.0 safety fields but not the
 * two added with the inspection budget. Merging keeps every stored value and backfills
 * whatever this build expects.
 */
export function normalizeMetrics(stored) {
    const defaults = createEmptyMetrics();
    if (!stored || typeof stored !== 'object')
        return defaults;
    const record = stored;
    const merged = { ...defaults };
    /**
     * Take the stored value only when it can be the same kind of thing as the default.
     *
     * A counter polluted by a persisted `NaN` arrives as `null`, and `null + 1` is 1 while
     * `null` itself is not a count - so a stored value whose type contradicts the default is
     * treated as missing and the default repairs it. Keys the defaults do not know are kept
     * as they are rather than dropped.
     */
    const pick = (fallback, value) => {
        if (isPlainObject(fallback) && isPlainObject(value)) {
            const section = { ...fallback };
            for (const [inner, innerValue] of Object.entries(value)) {
                section[inner] = pick(section[inner], innerValue);
            }
            return section;
        }
        if (fallback === undefined)
            return value;
        if (value === undefined)
            return fallback;
        return typeof value === typeof fallback ? value : fallback;
    };
    for (const [key, value] of Object.entries(record)) {
        merged[key] = pick(defaults[key], value);
    }
    return merged;
}
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export class MetricsCollector {
    data;
    explicitPath;
    constructor(customPath) {
        this.explicitPath = customPath;
    }
    /** Resolved storage path; first call pins it for this instance. */
    storagePath() {
        return resolveMetricsPath(this.explicitPath);
    }
    /** Current data, loading the persisted file on first access. */
    state() {
        if (!this.data)
            this.data = this.loadInitial();
        return this.data;
    }
    loadInitial() {
        const path = this.storagePath();
        try {
            if (existsSync(path)) {
                const raw = readFileSync(path, 'utf8');
                const parsed = JSON.parse(raw);
                // v1 counted flat per-tool token estimates and has no measured fields;
                // it is not migrated, the collector restarts on the measured schema.
                if (parsed && parsed.version === 2) {
                    // Backfill fields this build expects but the file predates.
                    return normalizeMetrics(parsed);
                }
            }
        }
        catch {
            // Fallback to empty on corrupt or unreadable file
        }
        return createEmptyMetrics();
    }
    persist() {
        const data = this.state();
        try {
            data.lastUpdatedAt = new Date().toISOString();
            mkdirSync(dirname(this.storagePath()), { recursive: true });
            writeFileSync(this.storagePath(), JSON.stringify(data, null, 2), 'utf8');
        }
        catch {
            // Ignore background file persistence errors in read-only environments
        }
    }
    /**
     * Record a tool pruning evaluation.
     * @param candidatesCount Total candidate tools evaluated
     * @param retainedCount Tools retained after pruning
     * @param measured Exact removal facts: code points dropped and their token price.
     */
    recordPrune(candidatesCount, retainedCount, measured) {
        const pruned = Math.max(0, candidatesCount - retainedCount);
        this.state().toolPruner.evaluations += 1;
        this.state().toolPruner.toolsPruned += pruned;
        this.state().toolPruner.toolsRetained += retainedCount;
        this.state().toolPruner.removedSchemaChars += measured.removedChars;
        this.state().toolPruner.estimatedTokensSaved += measured.estimatedTokens;
        if (this.state().toolPruner.tokenSource !== measured.tokenSource) {
            this.state().toolPruner.tokenSource = 'mixed';
        }
        this.persist();
    }
    /**
     * Record a loop guard check outcome.
     */
    recordLoopCheck(outcome) {
        this.state().loopGuard.checks += 1;
        if (outcome === 'warn') {
            this.state().loopGuard.warned += 1;
            this.state().loopGuard.notices += 1;
        }
        else if (outcome === 'interrupt') {
            this.state().loopGuard.interrupted += 1;
            this.state().loopGuard.notices += 1;
        }
        else if (outcome === 'uncertain') {
            this.state().loopGuard.uncertain += 1;
        }
        this.persist();
    }
    /** Record a denial produced by the deterministic envelope. */
    recordHardDeny() {
        this.state().safetyGuard.screened += 1;
        this.state().safetyGuard.blocked += 1;
        this.state().safetyGuard.hardDenied += 1;
        this.persist();
    }
    /** Record a denial produced by a fail-closed policy on an unusable verdict. */
    recordUncertainDeny() {
        this.state().safetyGuard.screened += 1;
        this.state().safetyGuard.blocked += 1;
        this.state().safetyGuard.uncertainDenied += 1;
        this.persist();
    }
    /**
     * Record a safety guard pre-execution screen.
     */
    recordSafetyCheck(outcome) {
        if (outcome === 'warn')
            this.state().safetyGuard.warned += 1;
        this.state().safetyGuard.screened += 1;
        if (outcome === 'ask') {
            this.state().safetyGuard.approvals += 1;
        }
        else if (outcome === 'deny') {
            this.state().safetyGuard.blocked += 1;
        }
        this.persist();
    }
    /**
     * Record a retry after a transient inspection failure.
     *
     * Counted so the budget can be sized from data: a rising retry count means the
     * inspection timeout is too tight, which is how the 800ms budget went unnoticed.
     */
    recordSafetyRetry() {
        this.state().safetyGuard.inspectionRetries += 1;
        this.persist();
    }
    /** Record an inspection that failed after its retries, so the failure policy applied. */
    recordSafetyInspectionFailure() {
        this.state().safetyGuard.inspectionFailures += 1;
        this.persist();
    }
    /**
     * Record a System One API call latency.
     */
    recordCall(latencyMs, success = true, accounting = {}) {
        this.state().systemOne.totalCalls += 1;
        this.state().systemOne.inputBytes += accounting.inputBytes ?? 0;
        this.state().systemOne.estimatedCostUsd += accounting.estimatedCostUsd ?? 0;
        if (accounting.cacheHit)
            this.state().systemOne.cacheHits += 1;
        if (accounting.decisionError)
            this.state().systemOne.decisionErrors += 1;
        if (success) {
            // A cache hit must not dilute the measured latency of real decisions.
            if (!accounting.cacheHit) {
                this.state().systemOne.totalLatencyMs += latencyMs;
                this.state().systemOne.latencySamples += 1;
            }
            this.state().systemOne.avgLatencyMs = Math.round(this.state().systemOne.totalLatencyMs / Math.max(1, this.state().systemOne.latencySamples));
        }
        else {
            this.state().systemOne.errors += 1;
        }
        this.persist();
    }
    /**
     * Record a semantically shaped tool result.
     * @param charsRemoved Exact characters dropped from the model-facing content.
     */
    recordShape(charsRemoved) {
        this.state().resultShaper.shaped += 1;
        this.state().resultShaper.charsRemoved += Math.max(0, charsRemoved);
        this.persist();
    }
    /** Record a decision whose answer was unusable (missing or malformed). */
    recordDecisionError() {
        this.state().systemOne.decisionErrors += 1;
        this.persist();
    }
    /**
     * Return an immutable snapshot of current metrics.
     */
    getSnapshot() {
        return JSON.parse(JSON.stringify(this.state()));
    }
    /**
     * Tokens saved, measured only where measurement exists: the removed tool
     * schemas. Loop notices prevent work but their avoided cost is not measurable,
     * so they are reported as a count instead of an invented token total.
     */
    getTotalTokensSaved() {
        return this.state().toolPruner.estimatedTokensSaved;
    }
    /**
     * Render a human-friendly Markdown dashboard card.
     */
    renderMarkdownDashboard() {
        const totalTokens = this.getTotalTokensSaved();
        const formattedTokens = totalTokens >= 1_000_000
            ? `${(totalTokens / 1_000_000).toFixed(2)}M`
            : totalTokens >= 1_000
                ? `${(totalTokens / 1_000).toFixed(1)}K`
                : String(totalTokens);
        return [
            `### 🛡️ TypeSafe Jev Guard & Efficiency Dashboard`,
            ``,
            `| Guard dimension | Core protection / optimization results | Estimated token / cost benefit |`,
            `| :--- | :--- | :--- |`,
            `| **🛠️ Dynamic Tool Pruning** | Evaluated **${this.state().toolPruner.evaluations}** times, pruned **${this.state().toolPruner.toolsPruned}** irrelevant tools (exactly **${this.state().toolPruner.removedSchemaChars}** schema characters removed) | Saved approximately **${(this.state().toolPruner.estimatedTokensSaved / 1000).toFixed(1)}K** tokens (estimation: ${this.state().toolPruner.tokenSource === 'tokenMeter' ? 'DSH tokenMeter estimator' : this.state().toolPruner.tokenSource === 'mixed' ? 'tokenMeter + local heuristic' : 'Local heuristic'}) |`,
            `| **🔄 Loop Protection** | Checked **${this.state().loopGuard.checks}** times, interrupted **${this.state().loopGuard.interrupted}** loops, issued **${this.state().loopGuard.warned}** warnings, and injected **${this.state().loopGuard.notices}** notices | No token estimate is reported because avoided cost is not directly measurable; unavailable decisions: **${this.state().loopGuard.uncertain}** |`,
            `| **🔒 Execution Safety Guard** | Screened **${this.state().safetyGuard.screened}** operations, blocked **${this.state().safetyGuard.blocked}** (deterministic: **${this.state().safetyGuard.hardDenied}** / unavailable fail-closed: **${this.state().safetyGuard.uncertainDenied}**), requested approval **${this.state().safetyGuard.approvals}** times, warnings without prompt: **${this.state().safetyGuard.warned}** | Deterministic wrapper can reject with 0 model calls; inspection retries: **${this.state().safetyGuard.inspectionRetries}**, final failures: **${this.state().safetyGuard.inspectionFailures}** (for calibrating inspectionTimeoutMs) |`,
            `| **🧩 Semantic Result Shaping** | Shaped **${this.state().resultShaper.shaped}** results and removed exactly **${this.state().resultShaper.charsRemoved}** characters | Disabled by default; applies only to repetitive content from output-heavy tools and returns the original output when unavailable |`,
            `| **⚡ System One Performance** | **${this.state().systemOne.totalCalls}** total decisions (**${this.state().systemOne.cacheHits}** cache hits), **${this.state().systemOne.avgLatencyMs}ms** average latency, **${this.state().systemOne.errors}** errors | Input: **${(this.state().systemOne.inputBytes / 1024).toFixed(1)}KB**, estimated at **$${this.state().systemOne.estimatedCostUsd.toFixed(4)}** using $0.042/M input tokens (output free) |`,
            ``,
            `> 💡 **Cumulative measurable benefit**: exactly **${this.state().toolPruner.removedSchemaChars}** tool-schema characters removed, estimated at **~${formattedTokens}** tokens. Loop and safety protections report counts only because avoided token cost is not directly measurable.`,
            `> ⏱️ Statistics since: \`${this.state().firstRecordedAt.replace('T', ' ').slice(0, 19)}\` (last updated: \`${this.state().lastUpdatedAt.replace('T', ' ').slice(0, 19)}\`)`,
        ].join('\n');
    }
    /**
     * Reset all metrics to zero.
     */
    reset() {
        this.data = createEmptyMetrics();
        this.persist();
    }
}
/** Global shared instance */
export const defaultMetrics = new MetricsCollector();
//# sourceMappingURL=metrics.js.map