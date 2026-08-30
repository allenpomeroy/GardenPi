
if [ ! -d /opt/gardenpi/webui ]; then
  echo "/opt/gardenpi/webui does not exist, unpack gardenpi-webui.zip first"
  exit 1
fi
sudo chown -R pi:pi /opt/gardenpi/webui
sudo /bin/su - pi -c "cd /opt/gardenpi/webui && npm install"
