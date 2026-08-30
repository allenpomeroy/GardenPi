

if [ ! -d /opt/gardenpi/python3 ]; then
  echo "/opt/gardenpi/python3 venv does not exist, set it up first"
  echo
  echo "sudo mkdir /opt/gardenpi/python3"
  echo "sudo chown pi:pi /opt/gardenpi/python3"
  echo "sudo /bin/su - pi -c \"python3 -m venv /opt/gardenpi/python3\""
  exit 1
fi
sudo chown -R pi:pi /opt/gardenpi/python3
sudo /bin/su - pi -c "source /opt/gardenpi/python3/bin/activate && pip install flask gunicorn sdnotify"

