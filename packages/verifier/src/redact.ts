/**
 * Secret-free rendering of endpoint URLs before they reach a report.
 *
 * `--rpc-url` is the intended way to satisfy LEDGER-INTEGRITY-DESIGN.md §14
 * steps 10-11, and managed Base endpoints carry the API key in the URL path or
 * query, so the URL itself is credential-bearing. The project has already
 * ruled on this for the publisher side — `AnchorReceipt.rpcEndpointLabel` is a
 * label, never a URL (packages/types/src/schemas-integrity.ts) — and
 * `verification-report.json` is a published bundle artifact (bundle format §1,
 * §9; LEDGER §12), so nothing that lands in `gaps` or on stderr may contain
 * more than the endpoint's origin.
 */

/** Origin only: no userinfo, no path, no query, no fragment. */
export function safeEndpoint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '<endpoint>';
  }
  if (parsed.origin !== 'null') {
    return parsed.origin;
  }
  // Non-special schemes have no origin; the scheme alone is still secret-free.
  return parsed.protocol;
}

const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/giu;

/**
 * Replaces every URL inside `text` with {@link safeEndpoint}, so a provider
 * error message that echoes the request URL cannot leak an embedded key.
 */
export function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, (match) => safeEndpoint(match));
}

/** `redactUrls` over an unknown thrown value. */
export function describeRedacted(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error));
}
