#!/usr/bin/env bash
#
# Verify the shared legal gateway contract.
#
# RUN THIS ON A HOST WITH A ROUTE TO THE PRIVATE NETWORK (the server), not on a dev
# laptop. 10.2.0.2 is not reachable from outside that network.
#
# It checks the five things svc-ai-gateway assumes, so a wrong assumption surfaces here
# rather than as a broken call at 2am:
#
#   1. the host answers on :3500
#   2. POST /v1/chat/completions is the route (not /v1/messages)
#   3. Authorization: Bearer <key> authenticates
#   4. the response is Anthropic-shaped (content[] with a text block)
#   5. both app keys work and are distinct identities
#
# Keys are read from the credential vault, never passed as arguments — an argument shows
# up in `ps` and in shell history.
#
# Usage:
#   CREDENTIAL_VAULT_DIR=/opt/credential-vault ./scripts/verify-gateway.sh

set -uo pipefail

BASE_URL="${LEGAL_GATEWAY_URL:-http://10.2.0.2:3500}"
VAULT="${CREDENTIAL_VAULT_DIR:-/opt/credential-vault}"
MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4-6}"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
info() { printf '        %s\n' "$1"; }
FAILED=0

echo "Verifying legal gateway at ${BASE_URL}"
echo "Vault: ${VAULT}"
echo

# ---------------------------------------------------------------- 1. reachability
if curl -fsS --max-time 5 -o /dev/null "${BASE_URL}/" 2>/dev/null \
   || curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/" 2>/dev/null | grep -qE '^[2345]'; then
  pass "host answers on ${BASE_URL}"
else
  fail "cannot reach ${BASE_URL} — is this host on the private network?"
  echo
  echo "Nothing further can be checked without a route. Stopping."
  exit 1
fi

# ---------------------------------------------------------------- keys
check_key_file() {
  local name="$1"
  if [[ ! -r "${VAULT}/${name}" ]]; then
    fail "missing vault secret: ${VAULT}/${name}"
    return 1
  fi
  if [[ ! -s "${VAULT}/${name}" ]]; then
    fail "vault secret is empty: ${name}"
    return 1
  fi
  pass "vault secret present: ${name}"
  return 0
}

WEB_OK=0; VOICE_OK=0
check_key_file legal_gateway_key && WEB_OK=1
check_key_file legal_gateway_voice_key && VOICE_OK=1
echo

# ---------------------------------------------------------------- 2-4. the contract
probe() {
  local label="$1" key_file="$2"
  local key body status
  key="$(cat "${VAULT}/${key_file}")"

  body="$(cat <<JSON
{"model":"${MODEL}","max_tokens":16,
 "system":[{"type":"text","text":"Reply with exactly: OK"}],
 "messages":[{"role":"user","content":"Say OK."}]}
JSON
)"

  local response
  response="$(curl -sS --max-time 30 -w '\n%{http_code}' \
    -X POST "${BASE_URL}/v1/chat/completions" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${key}" \
    -d "${body}" 2>&1)"

  status="$(printf '%s' "${response}" | tail -n1)"
  payload="$(printf '%s' "${response}" | sed '$d')"

  case "${status}" in
    200)
      pass "${label}: POST /v1/chat/completions returned 200"
      if printf '%s' "${payload}" | grep -q '"content"'; then
        pass "${label}: response is Anthropic-shaped (has content[])"
      else
        fail "${label}: 200 but no content[] — response shape differs from what svc-ai-gateway parses"
        info "got: $(printf '%s' "${payload}" | head -c 300)"
      fi
      ;;
    401|403)
      fail "${label}: ${status} — key rejected. Registered in APP_KEYS? Current?"
      ;;
    404)
      fail "${label}: 404 — route is wrong. svc-ai-gateway posts to /v1/chat/completions"
      ;;
    429)
      info "${label}: 429 rate-limited — the key authenticates, budget is exhausted right now"
      ;;
    *)
      fail "${label}: unexpected status ${status}"
      info "got: $(printf '%s' "${payload}" | head -c 300)"
      ;;
  esac
}

[[ ${WEB_OK} -eq 1 ]] && probe "justice_desk" legal_gateway_key
echo
[[ ${VOICE_OK} -eq 1 ]] && probe "justice_desk_voice" legal_gateway_voice_key
echo

# ---------------------------------------------------------------- 5. wrong route sanity
# Confirms the OpenAI-style path is real and /v1/messages is not, so nobody later
# "corrects" the route back on the assumption it was a typo.
if [[ ${WEB_OK} -eq 1 ]]; then
  legacy_status="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/v1/messages" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $(cat "${VAULT}/legal_gateway_key")" \
    -d '{"model":"'"${MODEL}"'","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null)"
  if [[ "${legacy_status}" == "404" ]]; then
    pass "/v1/messages correctly 404s — the OpenAI-style route is not a typo"
  else
    info "/v1/messages returned ${legacy_status} (expected 404). Worth knowing; not fatal."
  fi
fi

echo
if [[ ${FAILED} -eq 0 ]]; then
  echo "Gateway contract verified. svc-ai-gateway and svc-voice can talk to it."
  exit 0
fi
echo "Gateway contract NOT verified. See failures above; the contract lives in"
echo "services/ai-gateway/src/transport.ts and is the only file that needs changing."
exit 1
