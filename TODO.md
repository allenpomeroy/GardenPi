# TODO List

As of 2026/09/23

## Errors and errata

`/opt/gardenpi/config/garden.json` updates
- Fields are not updated on Configuration > Save changes:
  - config.last_changed
  - config.version

## Additional functionality

- add ability to restart services via webui
  - during install / setup add sudo no-password for all gardenpi-* services
  - add list of gardenpi-* services in Configuration UI
  - add Restart button for each as well as Restart All
  - will not add a Stop button, since if gardenpi-webui stops, ssh command line is required to restart
- consider adding System Restart button and sudo function
- consider adding System Shutdown button and sudo function, with PiJuice battery it will actually power off the system

