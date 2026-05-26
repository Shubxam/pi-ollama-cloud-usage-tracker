/**
 * Ollama Cloud usage scraper — cookie extraction + HTML scraping.
 *
 * Cookie extraction strategy (tried in order):
 *  1. @steipete/sweet-cookie (pure TS, no subprocess) — works if secret-tool/gi available
 *  2. Python helper with browser_cookie3 — full cookie extraction, no keyring hassles
 *  3. Python helper returns just a password — feed it back to sweet-cookie via env var
 *
 * The Python helper tries: gi → secret-tool → browser_cookie3.
 * It tries multiple python interpreters (python3.10, python3, …) since
 * browser_cookie3 may only be installed on one.
 *
 * When nothing works, a clear error message is returned so the UI can
 * tell the user exactly what to install.
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

/** Result when cookies could not be obtained — carries a user-facing message. */
export interface CookieError {
  error: string;
  hint: string;
}

export type CookieResult = { header: string; method: string } | CookieError;

interface PythonHelperResult {
  password?: string;
  cookies?: Record<string, string>;
  method?: string;
  confidence?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// User-facing error messages
// ---------------------------------------------------------------------------

const ERR_NO_PYTHON: CookieError = {
  error: "Cannot decrypt Chrome cookies",
  hint: "Install python3-gi + gir1.2-secret-1 (apt), or: pip install browser-cookie3",
};

const ERR_NO_KEYRING: CookieError = {
  error: "Cannot decrypt Chrome cookies",
  hint: "Install python3-gi + gir1.2-secret-1 (apt), or: pip install browser-cookie3",
};

const ERR_NO_LOGIN: CookieError = {
  error: "No ollama.com session",
  hint: "Log in to ollama.com in Chrome, then /reload this session",
};

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

    // Suppress expected Linux warnings (keyring unavailable, BigInt in sqlite)
    // — the Python fallback handles these. Only log unexpected ones.
    const unexpected = warnings.filter(w =>
      !w.includes("keyring") &&
      !w.includes("secret-tool") &&
      !w.includes("BigInt") &&
      !w.includes("too large") &&
      !w.includes("v11 cookies")
    );
    if (unexpected.length > 0) {
      console.error("[ollama-usage] sweet-cookie warnings:", unexpected.join("; "));
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
async function getOllamaCookies(): Promise<CookieResult> {
  // 1. Try sweet-cookie directly (no subprocess)
  const direct = await trySweetCookie();
  if (direct && "header" in direct) return direct;

  // 2. Try Python helpers (multiple interpreters)
  let anyPythonFound = false;
  let bestPythonResult: PythonHelperResult | null = null;

  for (const pythonBin of ["python3.10", "python3.12", "python3.13", "python3"]) {
    const pyResult = await runPythonHelper(pythonBin);
    if (pyResult === null) continue; // python binary not found
    anyPythonFound = true;

    // Python returned full decrypted cookies — use directly
    if (pyResult.cookies && Object.keys(pyResult.cookies).length > 0) {
      return { header: buildCookieHeader(pyResult.cookies), method: `python-${pyResult.method}` };
    }

    // Track the best result so far for potential sweet-cookie retry
    if (!bestPythonResult || (pyResult.password && pyResult.confidence !== "low")) {
      bestPythonResult = pyResult;
    }
  }

  // 3. If Python gave us a keyring password, feed it to sweet-cookie
  if (bestPythonResult?.password && bestPythonResult.confidence !== "low") {
    const retry = await trySweetCookie(bestPythonResult.password);
    if (retry && "header" in retry) return retry;
  }

  // 4. All methods failed — return a helpful error
  if (!anyPythonFound) return ERR_NO_PYTHON;
  if (bestPythonResult?.method === "fallback") return ERR_NO_KEYRING;
  return ERR_NO_LOGIN;
}

/** Run the Python keyring helper with a specific interpreter. */
function runPythonHelper(pythonBin: string): Promise<PythonHelperResult | null> {
  return new Promise((resolve) => {
    const scriptPath = join(__dirname, "get-keyring-password.py");
    execFile(pythonBin, [scriptPath], { timeout: 10_000, maxBuffer: 8192 }, (err, stdout) => {
      if (err) {
        // Python binary not found or script failed — skip silently
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

    // If we got an error instead of cookies, store it for the UI
    if ("error" in cookieResult) {
      console.error(`[ollama-usage] ${cookieResult.error} — ${cookieResult.hint}`);
      lastCookieError = cookieResult;
      return null;
    }

    lastCookieError = null; // clear any previous error

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
      lastCookieError = ERR_NO_LOGIN;
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

/** Most recent cookie extraction error, exposed for the UI. */
export let lastCookieError: CookieError | null = null;

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