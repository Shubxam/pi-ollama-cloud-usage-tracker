/**
 * Ollama Cloud usage scraper — cookie extraction + HTML scraping.
 *
 * Cookie extraction strategy (tried in order):
 *  1. @steipete/sweet-cookie (pure TS, no subprocess) — works if secret-tool/gi available
 *  2. Python helper with browser_cookie3 — full cookie extraction, no keyring hassles
 *  3. Python helper returns just a password — feed it back to sweet-cookie via env var
 *
 * The Python helper tries: gi → secret-tool → browser_cookie3.
 * It tries multiple python interpreters (python3, python3.10, …) since
 * browser_cookie3 may only be installed on one.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getCookies, toCookieHeader } from "@steipete/sweet-cookie";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

interface CookieResult {
  header: string;
  method: string;
}

interface PythonHelperResult {
  password?: string;
  cookies?: Record<string, string>;
  method?: string;
  confidence?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Cookie extraction
// ---------------------------------------------------------------------------

/** Try @steipete/sweet-cookie first (fast, no subprocess). */
async function trySweetCookie(envPassword?: string): Promise<CookieResult | null> {
  const prev = process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD;
  if (envPassword) {
    process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD = envPassword;
  }
  try {
    const { cookies, warnings } = await getCookies({
      url: "https://ollama.com/",
      browsers: ["chrome"],
    });
    if (warnings.length > 0) {
      console.error("[ollama-usage] sweet-cookie warnings:", warnings.join("; "));
    }
    const usable = cookies.filter((c) => c.value !== null && c.value !== "");
    if (usable.length > 0) {
      return {
        header: toCookieHeader(cookies, { dedupeByName: true }),
        method: envPassword ? "sweet-cookie+keyring" : "sweet-cookie",
      };
    }
  } catch (err: unknown) {
    console.error("[ollama-usage] sweet-cookie failed:", err instanceof Error ? err.message : err);
  } finally {
    if (envPassword) {
      if (prev === undefined) {
        delete process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD;
      } else {
        process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD = prev;
      }
    }
  }
  return null;
}

/** Build a Cookie header from a name→value map (browser_cookie3 path). */
function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** Try multiple methods to get ollama.com cookies. */
async function getOllamaCookies(): Promise<CookieResult | null> {
  // 1. Try sweet-cookie directly (no subprocess)
  const direct = await trySweetCookie();
  if (direct) return direct;

  // 2. Try Python helpers (multiple interpreters)
  for (const pythonBin of ["python3.10", "python3.12", "python3.13", "python3"]) {
    const pyResult = await runPythonHelper(pythonBin);
    if (!pyResult) continue; // python not found

    // Python returned full decrypted cookies — use directly
    if (pyResult.cookies && Object.keys(pyResult.cookies).length > 0) {
      return { header: buildCookieHeader(pyResult.cookies), method: `python-${pyResult.method}` };
    }

    // Python returned a keyring password — feed it to sweet-cookie
    if (pyResult.password && pyResult.confidence !== "low") {
      const retry = await trySweetCookie(pyResult.password);
      if (retry) return retry;
    }
  }

  console.error("[ollama-usage] No cookies available (Chrome not logged in or keyring locked)");
  return null;
}

/** Run the Python keyring helper with a specific interpreter. */
function runPythonHelper(pythonBin: string): Promise<PythonHelperResult | null> {
  return new Promise((resolve) => {
    const scriptPath = join(__dirname, "get-keyring-password.py");
    execFile(pythonBin, [scriptPath], { timeout: 10_000, maxBuffer: 8192 }, (err, stdout) => {
      if (err) {
        // Python binary not found or script failed — try next
        return resolve(null);
      }
      try {
        const data = JSON.parse(stdout.trim()) as PythonHelperResult;
        if ((data as { error?: string }).error) {
          console.error(`[ollama-usage] ${pythonBin} helper:`, (data as { error: string }).error);
          return resolve(null);
        }
        resolve(data);
      } catch {
        console.error(`[ollama-usage] ${pythonBin} helper: bad JSON`);
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main fetch
// ---------------------------------------------------------------------------

const SETTINGS_URL = "https://ollama.com/settings";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Fetch Ollama Cloud usage from the settings dashboard. */
export async function fetchUsage(): Promise<UsageData | null> {
  try {
    const cookieResult = await getOllamaCookies();
    if (!cookieResult) return null;

    const resp = await fetch(SETTINGS_URL, {
      headers: {
        Cookie: cookieResult.header,
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    });

    if (resp.status >= 300 && resp.status < 400) {
      console.error("[ollama-usage] redirected (session expired?)");
      return null;
    }
    if (!resp.ok) {
      console.error("[ollama-usage] settings fetch failed:", resp.status);
      return null;
    }

    const html = await resp.text();
    return parseUsageHtml(html);
  } catch (err: unknown) {
    console.error("[ollama-usage] fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML parser
// ---------------------------------------------------------------------------

function parseUsageHtml(html: string): UsageData | null {
  const result: Partial<UsageData> = {
    fetched_at: new Date().toISOString(),
  };

  const usagePattern = /aria-label="(Session|Weekly) usage (\d+(?:\.\d+)?)%/g;
  const timePattern = /data-time="([^"]+)"/g;

  const usages: Array<{ window: "session" | "weekly"; pct: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = usagePattern.exec(html)) !== null) {
    usages.push({ window: match[1].toLowerCase() as "session" | "weekly", pct: parseFloat(match[2]) });
  }

  const timestamps: string[] = [];
  while ((match = timePattern.exec(html)) !== null) {
    timestamps.push(match[1]);
  }

  for (const { window, pct } of usages) {
    (result as Record<string, unknown>)[`${window}_pct`] = pct;
  }

  if (timestamps.length >= 1 && usages.some((u) => u.window === "session")) {
    result.session_resets_at = timestamps[0];
  }
  if (timestamps.length >= 2 && usages.some((u) => u.window === "weekly")) {
    result.weekly_resets_at = timestamps[1];
  }
  if (timestamps.length === 1 && result.session_resets_at === undefined && result.weekly_pct !== undefined) {
    result.weekly_resets_at = timestamps[0];
  }

  if (result.session_pct === undefined) {
    console.error("[ollama-usage] No usage data found on page");
    return null;
  }

  return result as UsageData;
}