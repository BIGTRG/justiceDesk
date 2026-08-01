#!/usr/bin/env bash
#
# Verify the shared legal gateway contract.
#
# RUN ON A HOST WITH A ROUTE TO THE PRIVATE NETWORK. 10.2.0.2 is not reachable from a dev
# laptop; the legal server reaches it via enp7s0 (10.2.0.4/32).
#
# Checks everything svc-ai-gateway actually sends. Check 4 exists because the gateway
# silently dropped `tools` for a while: requests returned 200 with a text answer instead
# of a tool_use block, which would have taken the whole assistant down — `callTool` throws
# when no tool comes back, the UPL classifier is wrapped in failClosed, and fail-closed
# turns that into "block everything". Safe, but a total outage that looks like a
# classifier fault rather than a gateway one. Never again without this catching it.
#
# Keys are read from the vault, never passed as arguments — an argument shows up in `ps`
# and in shell history.
#
# Usage:
#   CREDENTIAL_VAULT_DIR=/opt/credential-vault ./scripts/verify-gateway.sh

set -uo pipefail

BASE_URL="${LEGAL_GATEWAY_URL:-http://10.2.0.2:3500}"
VAULT="${CREDENTIAL_VAULT_DIR:-/opt/credential-vault}"
MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4-6}"
KEY_FILE="${GATEWAY_KEY_FILE:-legal_gateway_key}"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
info() { printf '        %s\n' "$1"; }
FAILED=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Verifying legal gateway at ${BASE_URL}"
echo

# ---------------------------------------------------------------- 0. key
if [[ ! -s "${VAULT}/${KEY_FILE}" ]]; then
  fail "missing or empty vault secret: ${VAULT}/${KEY_FILE}"
  exit 1
fi
KEY="$(cat "${VAULT}/${KEY_FILE}")"
pass "vault secret present: ${KEY_FILE}"

post() { # post <file> <outfile> [path]
  curl -sS --max-time 120 -o "$2" -w '%{http_code}' \
    -X POST "${BASE_URL}${3:-/v1/chat/completions}" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${KEY}" \
    -d @"$1" 2>/dev/null
}

# ---------------------------------------------------------------- 1. reachability
if curl -sS --max-time 8 -o "$TMP/h" -w '' -H "authorization: Bearer ${KEY}" "${BASE_URL}/health" 2>/dev/null; then
  pass "reachable — /health responded"
else
  fail "cannot reach ${BASE_URL} — is this host on the private network? (expect a 10.x address)"
  exit 1
fi

# ---------------------------------------------------------------- 2. base completion
cat > "$TMP/base.json" <<JSON
{"model":"${MODEL}","max_tokens":32,
 "system":[{"type":"text","text":"Reply with exactly: OK"}],
 "messages":[{"role":"user","content":"Say OK."}]}
JSON
code="$(post "$TMP/base.json" "$TMP/base.out")"
if [[ "$code" == "200" ]] && grep -q '"content"' "$TMP/base.out"; then
  pass "POST /v1/chat/completions returns an Anthropic-shaped response"
else
  fail "base completion failed (http ${code})"
  info "$(head -c 300 "$TMP/base.out")"
fi

# ---------------------------------------------------------------- 3. auth enforced
code="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/v1/chat/completions" -H 'content-type: application/json' \
  -H 'authorization: Bearer not-a-real-key' -d @"$TMP/base.json" 2>/dev/null)"
[[ "$code" == "401" || "$code" == "403" ]] \
  && pass "a bad key is rejected (${code})" \
  || fail "a bad key returned ${code} — auth is not enforced"

# ---------------------------------------------------------------- 4. TOOL PASSTHROUGH
# The one that regressed. Intake classification, summons OCR and the UPL classifier all
# depend on a forced tool call coming back as a tool_use block.
cat > "$TMP/tool.json" <<JSON
{"model":"${MODEL}","max_tokens":256,
 "system":[{"type":"text","text":"Classify the situation."}],
 "messages":[{"role":"user","content":"A company is suing me over an old credit card."}],
 "tools":[{"name":"record_classification","description":"Record the case type.",
   "input_schema":{"type":"object","properties":{"case_type":{"type":"string"}},"required":["case_type"]}}],
 "tool_choice":{"type":"tool","name":"record_classification"}}
JSON
code="$(post "$TMP/tool.json" "$TMP/tool.out")"
if [[ "$code" == "200" ]] && grep -q 'tool_use' "$TMP/tool.out"; then
  pass "forced tool calls pass through (tool_use returned)"
else
  fail "TOOLS ARE BEING DROPPED (http ${code}, no tool_use block)"
  info "This takes the whole assistant down, not just one feature: callTool throws, the"
  info "UPL classifier is wrapped in failClosed, and fail-closed blocks every response."
  info "The gateway must forward `tools` and `tool_choice` to Anthropic unchanged."
fi

# ---------------------------------------------------------------- 5. vision
# Summons OCR sends base64 photographs of court papers.
PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
cat > "$TMP/vision.json" <<JSON
{"model":"${MODEL}","max_tokens":64,
 "messages":[{"role":"user","content":[
   {"type":"image","source":{"type":"base64","media_type":"image/png","data":"${PNG}"}},
   {"type":"text","text":"One word: what colour?"}]}]}
JSON
code="$(post "$TMP/vision.json" "$TMP/vision.out")"
[[ "$code" == "200" ]] \
  && pass "image content blocks pass through (summons OCR)" \
  || { fail "vision failed (http ${code}) — summons OCR will not work"; info "$(head -c 200 "$TMP/vision.out")"; }

# ---------------------------------------------------------------- 6. cache_control
cat > "$TMP/cache.json" <<JSON
{"model":"${MODEL}","max_tokens":32,
 "system":[{"type":"text","text":"You are terse.","cache_control":{"type":"ephemeral"}}],
 "messages":[{"role":"user","content":"Say OK."}]}
JSON
code="$(post "$TMP/cache.json" "$TMP/cache.out")"
if [[ "$code" == "200" ]]; then
  if grep -q 'cache_read_input_tokens' "$TMP/cache.out"; then
    pass "cache_control accepted and cache usage is reported"
  else
    info "cache_control accepted but no cache usage fields — caching may be a no-op (cost only, not correctness)"
  fi
else
  fail "cache_control rejected (http ${code}) — prompt caching will not work"
fi

# ---------------------------------------------------------------- 7. route is not a typo
code="$(post "$TMP/base.json" /dev/null /v1/messages)"
[[ "$code" == "404" ]] \
  && pass "/v1/messages 404s — the OpenAI-style route is correct, not a typo" \
  || info "/v1/messages returned ${code} (expected 404). Worth knowing; not fatal."

echo
if [[ ${FAILED} -eq 0 ]]; then
  echo "Gateway contract verified. svc-ai-gateway and svc-voice can talk to it."
  exit 0
fi
echo "Gateway contract NOT verified. The contract lives in"
echo "services/ai-gateway/src/transport.ts and is the only file that needs changing."
exit 1
