
# restart-services.sh

stop_services="gardenpi-webui gardenpi-api gardenpi-adc gardenpi-irrigation gardenpi-weather gardenpi-leds"
start_services="gardenpi-leds gardenpi-adc gardenpi-irrigation gardenpi-weather gardenpi-api gardenpi-webui"

echo "stopping services"
for service in $stop_services
do
  echo "sudo systemctl stop $service"
  sudo systemctl stop $service
  sleep 1
done

sleep 1

echo
echo "starting services"
for service in $start_services
do
  echo "sudo systemctl start $service"
  sudo systemctl start $service
  sleep 1
done


