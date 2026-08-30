
# stop-services.sh

stop_services="gardenpi-webui gardenpi-api gardenpi-adc gardenpi-irrigation gardenpi-weather gardenpi-leds"
start_services="gardenpi-leds gardenpi-adc gardenpi-irrigation gardenpi-weather gardenpi-api gardenpi-webui"

echo "stopping services"
for service in $stop_services
do
  echo "sudo systemctl stop $service"
  sudo systemctl stop $service
done


