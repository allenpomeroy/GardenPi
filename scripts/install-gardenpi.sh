#
# install all gardenpi components
#

sudo ./fix-perms.sh

sudo ./setup-venv.sh
sudo ./setup-api.sh
sudo ./setup-webui.sh

sudo ./add-services.sh

./add-remove-logs-crontab.sh

