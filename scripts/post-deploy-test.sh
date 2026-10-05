#!/bin/bash
# post-deploy-test.sh
#
# Run on gctl11 as root after the update is in /opt/gardenpi (unzipped over
# it, git pull, or git am). Removes the copies of pijuice-safe-shutdown.py
# and remove-old-logs.py left in scripts/ (they moved to bin/), repoints
# cron, restarts services, and exercises the new/changed API endpoints.
set -uo pipefail
TOKEN=$(python3 -c "import json;print(json.load(open('/opt/gardenpi/config/garden.json'))['handlers']['api']['token'])")
B=https://localhost:5000

# Moved to bin/ - an unzip can't delete, so remove the old copies here
# (backed up first) once the new ones are confirmed in place.
for f in pijuice-safe-shutdown.py remove-old-logs.py; do
  if [ -f /opt/gardenpi/scripts/$f ]; then
    if [ -x /opt/gardenpi/bin/$f ]; then
      mkdir -p /opt/gardenpi/backup-moved && cp -p /opt/gardenpi/scripts/$f /opt/gardenpi/backup-moved/
      rm -f /opt/gardenpi/scripts/$f && echo "Removed old scripts/$f (copy in backup-moved/)"
    else
      echo "WARNING: bin/$f missing or not executable - leaving scripts/$f in place"
    fi
  fi
done

/opt/gardenpi/scripts/fix-perms.sh
# remove-old-logs.py moved to bin/: repoint the existing cron entry
/opt/gardenpi/scripts/add-remove-logs-crontab.sh
crontab -l -u "$(stat -c %U /opt/gardenpi/bin/api.py)" | grep remove-old-logs

systemctl restart gardenpi-irrigation; sleep 3
systemctl restart gardenpi-api gardenpi-webui; sleep 5
systemctl is-active gardenpi-irrigation gardenpi-api gardenpi-webui

echo "== /api (index)";            curl -sk $B/api | python3 -m json.tool | grep -E '"(method|path)"' | paste - - 
echo "== /api/health";             curl -sk -w "HTTP %{http_code}\n" $B/api/health
for p in adc/channels irrigation/relays weather/sensors; do
  echo "== /api/$p"; curl -sk -H "Authorization: Bearer $TOKEN" $B/api/$p | python3 -m json.tool | head -20
done
echo "== auth enforced (expect 401)"; curl -sk -o /dev/null -w "%{http_code}\n" $B/api/adc/channels
echo "== moved scripts (not run)"; ls -l /opt/gardenpi/bin/pijuice-safe-shutdown.py /opt/gardenpi/bin/remove-old-logs.py
echo "== web UI shutdown path"; grep -o "'/opt/gardenpi/[^']*pijuice-safe-shutdown.py'" /opt/gardenpi/webui/server/systemControl.js
