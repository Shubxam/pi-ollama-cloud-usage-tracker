/**
 * Ollama Cloud Usage Tracker — live usage stats in the pi footer right rail.
 *
 * Only active when the provider is ollama-cloud. Scrapes ollama.com/settings
 * via Chrome cookies every 5 min + after each agent turn.
 *
 * Footer layout (line 2, right-aligned):
 *   ↑3.4M ↓23k 8.7%/1.0M  5h ▕███░░░░░░░▏ 34% ⟳ 3h14m 7d ▕████░░░░░░▏ 45% ⟳ 3d16h  (ollama-cloud) model
 *
 * Install:  pi install /home/boni/src/pi-ollama-cloud-usage-tracker
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsageData {
  session_pct: number;
  weekly_pct: number;
  session_resets_at?: string;
  weekly_resets_at?: string;
  fetched_at: string;
}

interface UsageError {
  error: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run the Python scraper and return parsed usage data or null on failure. */
function fetchUsage(): Promise<UsageData | null> {
  return new Promise((resolve) => {
    const scriptPath = join(__dirname, "scrape_usage.py");
    execFile(
      "python3.10",
      [scriptPath],
      { timeout: 15_000, maxBuffer: 4096 },
      (err, stdout) => {
        if (err) {
          console.error("[ollama-usage] scraper failed:", err.message);
          return resolve(null);
        }
        try {
          const data = JSON.parse(stdout.trim());
          if ((data as UsageError).error) {
            console.error("[ollama-usage]", (data as UsageError).error);
            return resolve(null);
          }
          resolve(data as UsageData);
        } catch {
          console.error("[ollama-usage] bad JSON from scraper");
          resolve(null);
        }
      },
    );
  });
}

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
    theme: { fg: (color: string, text: string) => string },
  ): string {
    if (!lastData) return theme.fg("dim", "5h ▕░░░░░░░░░▏ — ⟳ — 7d ▕░░░░░░░░░▏ — ⟳ —");

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
      let color: string;
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

      const pctStr = `${Math.round(pct)}%`;
      return theme.fg(color, `${label} ▕${bar}▏ ${pctStr}`) + timeStr;
    }

    // Session window: 5h (18000 sec)
    const session = renderQuota("5h", lastData.session_pct, lastData.session_resets_at, 18000);
    // Weekly window: 7d (604800 sec)
    const weekly = renderQuota("7d", lastData.weekly_pct, lastData.weekly_resets_at, 604800);

    return `${session}  ${weekly}`;
  }

  /** Start the usage tracker (called when ollama-cloud is active). */
  function start(ctx: {
    cwd: string;
    model?: { provider: string; id: string } | null;
    sessionManager: {
      getBranch: () => Array<{
        type: string;
        message?: { role: string; usage: { input: number; output: number; cost: { total: number } } };
      }>;
    };
    getContextUsage: () => { tokens: number; maxTokens: number; percent: number } | null;
    ui: {
      setFooter: (f: ((tui: unknown, theme: Theme, fd: unknown) => { dispose?: () => void; invalidate: () => void; render: (w: number) => string[] }) | undefined) => void;
    };
  }) {
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
              const m = e.message as unknown as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
            }
          }

          // Context usage
          const ctxUsage = ctx.getContextUsage();
          const ctxPct = ctxUsage ? `${ctxUsage.percent.toFixed(0)}%` : "—";
          const ctxMax = (ctxUsage && typeof ctxUsage.maxTokens === "number" && !isNaN(ctxUsage.maxTokens)) 
            ? `/${fmt(ctxUsage.maxTokens)}` 
            : "";

          // Left: token stats + context
          const left = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)} ${ctxPct}${ctxMax}`);

          // Right: usage tracker + model info
          const usage = usageText(theme);
          const modelId = ctx.model?.id || "no model";
          const model = theme.fg("dim", `(${ctx.model?.provider || "?"}) ${modelId}`);
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
  function stop(ctx: { ui: { setFooter: (f: undefined) => void } }) {
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
  function isOllamaCloud(ctx: { model?: { provider: string } | null }): boolean {
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
