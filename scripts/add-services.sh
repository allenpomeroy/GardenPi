
# add-services.sh
#
# v2.0 2026/08/27
# - fixed: the install/enable loops referenced $services, which was never
#   defined (only $start_services was) - this silently did nothing on
#   every run. Renamed the loops to use $services and made it the
#   authoritative list.
# - added gardenpi-init to the list - it was previously never installed
#   or enabled by this script at all, even though gardenpi-leds/adc/
#   irrigation/weather all Require= it.
# - order matches restart-services.sh's mandatory startup sequence:
#   init -> leds -> adc -> irrigation -> weather -> api -> webui.

services="gardenpi-init gardenpi-leds gardenpi-adc gardenpi-irrigation gardenpi-weather gardenpi-api gardenpi-webui"

for service in $services
do
  echo "sudo cp ${service}.service /etc/systemd/system"
  sudo cp ${service}.service /etc/systemd/system
done

echo "sudo systemctl daemon-reload"
sudo systemctl daemon-reload

for service in $services
do
  echo "sudo systemctl enable $service --now"
  sudo systemctl enable $service --now
  sleep 1
done


