#!/usr/bin/env bash
# Read-only: is this checkout and its environment worth driving? Exit 1 if any FAIL.
cd "$(dirname "$0")/../../.." || exit 1
fail=0
ok() { echo "OK    $*"; }
warn() { echo "WARN  $*"; }
bad() { echo "FAIL  $*"; fail=1; }
envval() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | xargs; }

v=$(node -p 'process.versions.node' 2>/dev/null)
[[ ${v%%.*} -ge 24 ]] && ok "node $v" || bad "node ${v:-missing}: need 24+ for .ts type stripping"
[[ -f .env ]] && ok ".env present" || bad ".env missing: drive.ts reads MY_PHONE and API keys from it"
[[ -n $(envval MY_PHONE) ]] && ok "MY_PHONE set" || bad "MY_PHONE unset: --as owner has no identity"
[[ -d node_modules/@whiskeysockets/baileys ]] && ok "node_modules installed" || bad "run npm install"

bin=$(envval JOPLIN_BIN); bin=${bin:-joplin}
command -v "$bin" >/dev/null && ok "joplin CLI: $bin" || warn "joplin CLI '$bin' not found: Joplin journeys will fail"

hue=$(envval HUE_IP)
if [[ -n $hue ]]; then
  curl -s -m 3 -o /dev/null "http://$hue/api/config" && ok "Hue bridge $hue reachable" || warn "Hue bridge $hue unreachable: lights journeys will fail"
fi

url=$(envval AGENT_RUNNER_URL); url=${url:-http://127.0.0.1:3790}
s=$(curl -s -m 3 "$url/status") && ok "agent-runner $url: $s" || warn "agent-runner $url unreachable: !restart guard sees no runner"

st=$(pm2 jlist 2>/dev/null | node -e 'const p=JSON.parse(require("fs").readFileSync(0)).find(x=>x.name==="whatsapp");console.log(p?p.pm2_env.status:"absent")' 2>/dev/null)
echo "INFO  live bot (pm2 whatsapp): ${st:-unknown}. drive.ts never touches it."

exit $fail
