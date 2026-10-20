#!/usr/bin/env bash
# Removes drive.ts logs older than N days (default 7). Evidence JSON from the current run stays.
cd "$(dirname "$0")/../../.." || exit 1
days=${1:-7}
find logs/verify -type f \( -name '*.json' -o -name '*.log' \) -mtime +"$days" -print -delete 2>/dev/null
exit 0
