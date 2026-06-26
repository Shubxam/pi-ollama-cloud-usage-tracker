/**
 * Ollama Cloud Usage Tracker — live usage stats in the pi footer right rail.
 *
 * Only active when the provider is ollama-cloud. Scrapes ollama.com/settings
 * via Chrome cookies every 5 min + after each agent turn.
 *
 * Footer layout (line 2, right-aligned):
 *   ↑3.4M ↓23k 8.7%/1.0M  5h ▕███░░░░░░░▏ 34% ⟳ 3h14m 7d ▕████░░░░░░▏ 45% ⟳ 3d16h  (ollama-cloud) model
 *
 * Install:  pi install npm:@entelligentsia/pi-ollama-cloud-usage-tracker
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fetchUsage, lastCookieError } from "./scraper.js";
import type { UsageData, CookieError } from "./scraper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a number for display: <1k raw, >=1k with k suffix. */
function fmt(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let lastData: UsageData | null = null;
  let active = false;
  let onUsageUpdate: (() => void) | null = null;

  const OLLAMA_PROVIDER = "ollama-cloud";

  /** Refresh usage data, then call onUsageUpdate for TUI redraw. */
  async function refreshUsage() {
    const data = await fetchUsage();
    if (data) {
      lastData = data;
    }
    onUsageUpdate?.();
  }

  /** Build the right-side usage string with theme colors. */
  function usageText(
    theme: Theme,
  ): string {
    if (!lastData) {
      // Show actionable error if cookie extraction failed
      const err = lastCookieError as CookieError | null;
      if (err) {
        return theme.fg("error", err.error) + "  " + theme.fg("dim", err.hint);
      }
      return theme.fg("dim", "5h ▕░░░░░░░░░▏ — ⟳ — 7d ▕░░░░░░░░░▏ — ⟳ —");
    }

    /** Render a single quota segment: label ▕███░░░░░░░▏ pct% ⟳ time */
    function renderQuota(
      label: string,
      pct: number,
      resetsAt: string | undefined,
      windowSec: number,
    ): string {
      const now = Date.now();

      // Pace: delta between usage% and elapsed%
      const elapsedMs = resetsAt
        ? Math.min(Math.max(now - (new Date(resetsAt).getTime() - windowSec * 1000), 0), windowSec * 1000)
        : 0;
      const elapsedPct = (elapsedMs / (windowSec * 1000)) * 100;
      const delta = pct - elapsedPct;

      // Color by pace (suppress if too early in window)
      let color: Parameters<typeof theme.fg>[0];
      if (elapsedMs < 60_000 || elapsedPct < 1) {
        color = "accent"; // too early to judge pace
      } else if (delta > 5) {
        color = "error";
      } else if (delta > 2) {
        color = "warning";
      } else if (delta < -2) {
        color = "success";
      } else {
        color = "accent";
      }

      // Bar: 10 chars of █/░ between ▕ and ▏
      const filled = Math.min(Math.max(Math.floor(pct / 10), 0), 10);
      const bar = "█".repeat(filled) + "░".repeat(10 - filled);

      // Time until reset
      let timeStr = "";
      if (resetsAt) {
        const secsLeft = Math.max(0, Math.round((new Date(resetsAt).getTime() - now) / 1000));
        if (secsLeft === 0) {
          timeStr = "resetting";
        } else if (secsLeft < 3600) {
          timeStr = `${Math.floor(secsLeft / 60)}m`;
        } else if (secsLeft < 86400) {
          const h = Math.floor(secsLeft / 3600);
          const m = Math.floor((secsLeft % 3600) / 60);
          timeStr = m > 0 ? `${h}h${m}m` : `${h}h`;
        } else {
          const d = Math.floor(secsLeft / 86400);
          const h = Math.floor((secsLeft % 86400) / 3600);
          timeStr = h > 0 ? `${d}d${h}h` : `${d}d`;
        }
        timeStr = theme.fg("dim", ` ⟳ ${timeStr}`);
      }

      // Format percent with up to 2 decimals, but only when the fractional
      // part is non-zero — drop trailing zeros so 1% stays "1%", 0.2% stays
      // "0.2%", and 1.25% stays "1.25%". Matches what the ollama.com
      // dashboard shows instead of rounding everything to an integer.
      const rounded = Math.round(pct * 100) / 100; // quantize to 2dp
      const whole = Math.floor(rounded);
      let pctStr: string;
      if (Math.abs(rounded - whole) < 0.005) {
        // Within half a hundredth of an integer — show as integer.
        pctStr = `${whole}%`;
      } else {
        // Show up to 2 decimals, stripping trailing zeros (so 0.20 -> "0.2").
        const twoDp = rounded.toFixed(2);
        pctStr = `${twoDp.replace(/\.?0+$/, "")}%`;
      }
      return theme.fg(color, `${label} ▕${bar}▏ ${pctStr}`) + timeStr;
    }

    // Session window: 5h (18000 sec)
    const session = renderQuota("5h", lastData.session_pct, lastData.session_resets_at, 18000);
    // Weekly window: 7d (604800 sec)
    const weekly = renderQuota("7d", lastData.weekly_pct, lastData.weekly_resets_at, 604800);

    return `${session}  ${weekly}`;
  }

  /** Start the usage tracker (called when ollama-cloud is active). */
  function start(ctx: ExtensionContext) {
    if (active) return;
    active = true;

    // Initial fetch, then periodic
    refreshUsage();
    refreshTimer = setInterval(() => refreshUsage(), 5 * 60_000);

    // Captured so async fetch can trigger a redraw
    let tuiRef: { requestRender: () => void } | null = null;

    ctx.ui.setFooter((tui: { requestRender: () => void }, theme: Theme, footerData: { getGitBranch: () => string | null; onBranchChange: (cb: () => void) => () => void }) => {
      tuiRef = tui;
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: () => { unsub(); tuiRef = null; },
        invalidate() {},
        render(width: number): string[] {
          // Line 1: working directory + git branch
          const cwd = ctx.cwd.replace(process.env.HOME || "/home/boni", "~");
          const branch = footerData.getGitBranch();
          const cwdLine = branch ? `${cwd} (${branch})` : cwd;

          // Token stats
          let input = 0, output = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message?.role === "assistant") {
              input += e.message.usage.input;
              output += e.message.usage.output;
            }
          }

          // Context usage
          const ctxUsage = ctx.getContextUsage();
          const ctxPct = ctxUsage?.percent != null ? `${ctxUsage.percent.toFixed(0)}%` : "—";
          const ctxMax = (ctxUsage && ctxUsage.tokens != null && ctxUsage.contextWindow)
            ? `/${fmt(ctxUsage.contextWindow)}`
            : "";

          // Left: token stats + context
          const left = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)} ${ctxPct}${ctxMax}`);

          // Right: usage tracker + model info
          const usage = usageText(theme);
          const modelId = ctx.model?.id || "no model";
          const provider = ctx.model ? ("provider" in ctx.model ? (ctx.model as { provider: string }).provider : OLLAMA_PROVIDER) : OLLAMA_PROVIDER;
          const model = theme.fg("dim", `(${provider}) ${modelId}`);
          const right = `${usage}  ${model}`;

          // Layout: left ... pad ... right
          const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

          return [
            truncateToWidth(cwdLine, width),
            truncateToWidth(left + pad + right, width),
          ];
        },
      };
    });

    // Wire up TUI redraw so usage updates are visible immediately
    onUsageUpdate = () => tuiRef?.requestRender();
  }

  /** Stop and restore default footer. */
  function stop(ctx: ExtensionContext) {
    active = false;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    ctx.ui.setFooter(undefined);
    onUsageUpdate = null;
    lastData = null;
  }

  /** Check whether the current model uses ollama-cloud. */
  function isOllamaCloud(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === OLLAMA_PROVIDER;
  }

  // ---- Event handlers ----

  pi.on("session_start", async (_event, ctx) => {
    if (isOllamaCloud(ctx)) {
      start(ctx);
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    if (isOllamaCloud(ctx)) {
      start(ctx);
    } else {
      stop(ctx);
    }
  });

  // Refresh after agent finishes (catches usage consumed during the turn)
  pi.on("agent_end", async (_event, ctx) => {
    if (active && isOllamaCloud(ctx)) {
      await refreshUsage();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stop(ctx);
  });
}