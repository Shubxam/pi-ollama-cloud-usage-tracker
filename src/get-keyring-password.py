#!/usr/bin/env python3
"""Extract the Chrome Safe Storage password from the system keyring.

Tries multiple methods in order:
  1. PyGObject (gi) — pre-installed on most GNOME desktops
  2. secret-tool CLI — from libsecret-tools package
  3. browser_cookie3 — if available (uses jeepney/dbus-python under the hood)
  4. Fallback: "peanuts" (only works for v10 cookies)

Outputs JSON to stdout: {"password": "...", "method": "..." | "fallback"} or {"error": "..."}
"""

import json
import subprocess
import sys


def _try_gi():
    try:
        import gi
        gi.require_version("Secret", "1")
        from gi.repository import Secret

        for schema_name in [
            "chrome_libsecret_os_crypt_password_v2",
            "chrome_libsecret_os_crypt_password_v1",
        ]:
            schema = Secret.Schema.new(
                schema_name,
                Secret.SchemaFlags.NONE,
                {"application": Secret.SchemaAttributeType.STRING},
            )
            pw = Secret.password_lookup_sync(schema, {"application": "chrome"}, None)
            if pw:
                return pw

        # Generic lookup
        pw = Secret.password_lookup_sync(None, {"application": "chrome"}, None)
        if pw:
            return pw
    except Exception:
        pass
    return None


def _try_secret_tool():
    for args in [
        ["secret-tool", "lookup", "application", "chrome"],
        ["secret-tool", "lookup", "service", "Chrome Safe Storage", "account", "Chrome"],
    ]:
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=5)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    return None


def _try_browser_cookie3():
    """Use browser_cookie3 if available (it uses jeepney/dbus-python for keyring)."""
    try:
        import browser_cookie3
        bc = browser_cookie3.chrome(domain_name="ollama.com")
        cookies = list(bc)
        if cookies:
            # browser_cookie3 already decrypted — return the cookies directly
            result = {}
            for c in cookies:
                result[c.name] = c.value
            return result
    except Exception:
        pass
    return None


def main():
    # Method 1: gi (PyGObject)
    pw = _try_gi()
    if pw:
        print(json.dumps({"password": pw, "method": "gi"}))
        return

    # Method 2: secret-tool CLI
    pw = _try_secret_tool()
    if pw:
        print(json.dumps({"password": pw, "method": "secret-tool"}))
        return

    # Method 3: browser_cookie3 (returns full cookies, not just password)
    cookies = _try_browser_cookie3()
    if cookies:
        print(json.dumps({"cookies": cookies, "method": "browser_cookie3"}))
        return

    # Fallback: "peanuts" is Chrome's default password on some Linux systems.
    # It only works for v10 cookies, not v11. Return it but flag as low confidence.
    # The TS caller will try it with sweet-cookie but also try other python interpreters.
    print(json.dumps({"password": "peanuts", "method": "fallback", "confidence": "low"}))


if __name__ == "__main__":
    main()