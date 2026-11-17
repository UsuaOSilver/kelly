#!/usr/bin/env bash
# Walks the whole demo script against a running server.
B=${1:-http://127.0.0.1:8787}
c(){ echo "you   > $1"; curl -sS -m 90 -X POST $B/api/chat -H 'content-type: application/json' -d "{\"text\":\"$1\"}" | python3 -c "import json,sys;d=json.load(sys.stdin);print('kelly >',d['say']);print()"; }
c "what is mispriced in bitcoin"; c "size a bet"; c "approve"; c "put \$500 on it"; c "status"
curl -sS $B/api/state | python3 -c "
import json,sys;d=json.load(sys.stdin)
print('modes',d['modes'])
for e in d['ledger']: print(e['kind'].ljust(16),e['source'].ljust(15),(('\$%.3f'%e['amountUsd']) if e.get('amountUsd') else '').ljust(8),e['title'],'|',e.get('detail',''))"
