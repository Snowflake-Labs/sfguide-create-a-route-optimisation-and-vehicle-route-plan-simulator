#!/usr/bin/env bash
#
# install-fleet-apps / lib/endpoint_url.sh
#
# Single source of truth for "is this string an SPCS endpoint URL?".
#
# WHY THIS EXISTS
# ---------------
# While SPCS ingress is still coming up (~1-3 min after a service RESUME),
# `SHOW ENDPOINTS` does not return an empty ingress_url. It returns PROSE:
#
#   Endpoints provisioning in progress... check back in a few minutes
#
# Every caller builds its candidate as `'https://' || "ingress_url"`, which
# prefixes that sentence and produces a string that satisfies a naive
# `grep -E '^https://'`. Both app deploy scripts did exactly that and printed:
#
#   url:   https://Endpoints provisioning in progress... check back in a few minutes
#
# as if it were the app URL - a value that cannot be opened, in the one line a
# user copies. The installer's own resolver had independently grown a correct
# guard (a hostname-shaped pattern plus a negative match on the prose), so ONE
# rule was being enforced at THREE sites in TWO idioms, and only two of them
# were right. That is the drift this file removes.
#
# Contract: an unresolved endpoint yields EMPTY, never a placeholder. Callers
# must treat empty as "still provisioning" and suppress the line rather than
# print something false.

# Matches a hostname-shaped URL and nothing else: no whitespace (which the prose
# has), and at least one dot (which a bare word lacks). Deliberately strict -
# a false negative costs a retry, a false positive is published to a user.
ENDPOINT_URL_RE='^https://[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+$'

# Filter stdin down to the first line that is a real endpoint URL, else emit
# nothing. Belt-and-braces: the anchored regex alone already rejects the prose,
# and the negative match documents the specific string being guarded against.
endpoint_url_filter() {
  grep -E "$ENDPOINT_URL_RE" | grep -viE 'provisioning|in progress' | head -1 || true
}

# True when the argument is a usable endpoint URL.
is_endpoint_url() { # <candidate>
  printf '%s' "${1:-}" | grep -qE "$ENDPOINT_URL_RE"
}

# The SQL-side half of the same rule, for embedding in the SELECT that reads
# SHOW ENDPOINTS output. Rejects the placeholder before it is ever concatenated,
# so the candidate never has to be un-picked downstream.
# Usage:  ... WHERE "name" = 'x' AND $(endpoint_url_sql_guard)
endpoint_url_sql_guard() {
  printf '%s' '"ingress_url" NOT ILIKE '"'"'%provisioning%'"'"' AND "ingress_url" LIKE '"'"'%.%'"'"' AND "ingress_url" NOT LIKE '"'"'% %'"'"''
}
