/**
 * Ollama Cloud usage scraper — pure TypeScript replacement for scrape_usage.py.
 *
 * Extracts Chrome cookies via @steipete/sweet-cookie, fetches the settings
 * page, and parses usage percentages + reset timestamps from the HTML.
 */

import { getCookies, toCookieHeader } from "@steipete/sweet-cookie";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageData {
  session_pct: number;
  weekly_pct: number;
  session_resets_at?: string;
  weekly_resets_at?: string;
  fetched_at: string;
}

export interface UsageError {
  error: string;
}

export type UsageResult = UsageData | UsageError;

// ---------------------------------------------------------------------------
// Scrape
// ---------------------------------------------------------------------------

const SETTINGS_URL = "https://ollama.com/settings";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Fetch Ollama Cloud usage from the settings dashboard. */
export async function fetchUsage(): Promise<UsageData | null> {
  try {
    // 1. Get Chrome cookies for ollama.com
    const { cookies, warnings } = await getCookies({
      url: "https://ollama.com/",
      browsers: ["chrome"],
    });

    if (warnings.length > 0) {
      console.error("[ollama-usage] cookie warnings:", warnings.join("; "));
    }

    if (!cookies || cookies.length === 0) {
      console.error("[ollama-usage] No Chrome cookies found for ollama.com");
      return null;
    }

    const cookieHeader = toCookieHeader(cookies, { dedupeByName: true });

    // 2. Fetch the settings page
    const resp = await fetch(SETTINGS_URL, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    });

    // Redirect likely means cookies are invalid / session expired
    if (resp.status >= 300 && resp.status < 400) {
      console.error("[ollama-usage] redirected (session expired?)");
      return null;
    }
    if (!resp.ok) {
      console.error("[ollama-usage] settings fetch failed:", resp.status);
      return null;
    }

    const html = await resp.text();

    // 3. Parse usage data from HTML
    return parseUsageHtml(html);
  } catch (err: unknown) {
    console.error("[ollama-usage] scraper failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML parser
// ---------------------------------------------------------------------------

/**
 * Parse the ollama.com/settings HTML for usage data.
 *
 * The page contains elements like:
 *   <div aria-label="Session usage 34%">...</div>
 *   <div data-time="2026-05-26T18:30:00Z">...</div>
 *   <div aria-label="Weekly usage 45%">...</div>
 *   <div data-time="2026-06-01T00:00:00Z">...</div>
 */
function parseUsageHtml(html: string): UsageData | null {
  const result: Partial<UsageData> = {
    fetched_at: new Date().toISOString(),
  };

  // Find all aria-label usage markers
  const usagePattern =
    /aria-label="(Session|Weekly) usage (\d+(?:\.\d+)?)%/g;

  // Find all data-time timestamps (appear near usage meters)
  const timePattern = /data-time="([^"]+)"/g;

  // Collect usage percentages
  const usages: Array<{ window: "session" | "weekly"; pct: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = usagePattern.exec(html)) !== null) {
    const window = match[1].toLowerCase() as "session" | "weekly";
    const pct = parseFloat(match[2]);
    usages.push({ window, pct });
  }

  // Collect all reset timestamps
  const timestamps: string[] = [];
  while ((match = timePattern.exec(html)) !== null) {
    timestamps.push(match[1]);
  }

  // Associate percentages with their windows
  for (const { window, pct } of usages) {
    result[`${window}_pct` as keyof UsageData] = pct as never;
  }

  // Associate timestamps — assume order matches (session first, weekly second)
  // and each usage meter has exactly one data-time sibling
  if (timestamps.length >= 1 && usages.some((u) => u.window === "session")) {
    result.session_resets_at = timestamps[0];
  }
  if (timestamps.length >= 2 && usages.some((u) => u.window === "weekly")) {
    result.weekly_resets_at = timestamps[1];
  }
  // If there's only one timestamp and it belongs to weekly (no session timestamp found)
  if (timestamps.length === 1 && !result.session_resets_at && result.weekly_pct !== undefined) {
    result.weekly_resets_at = timestamps[0];
  }

  if (result.session_pct === undefined) {
    console.error("[ollama-usage] No usage data found on page");
    return null;
  }

  return result as UsageData;
}