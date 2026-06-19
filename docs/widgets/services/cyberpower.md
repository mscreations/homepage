---
title: Cyberpower UPS Monitoring
description: Lightweight monitoring widget for Cyberpower UPSs using the RMCARD205 API
---

This widget extracts UPS information from a Cyberpower RMCARD205 API. It has been tested on firmware version v1.6.0.


To download the latest firmware for your UPS, go to [Firmware download page](https://www.cyberpowersystems.com/product/ups/hardware/rmcard205/#tab-documents).


```yaml
widget:
  type: cyberpower
  url: http://ups.example.com
  username: admin
  password: password
```
