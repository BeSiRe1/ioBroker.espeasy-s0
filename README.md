![Logo](admin/espeasy-s0.png)

# ioBroker.espeasy-s0

[![Test and Release](https://github.com/BeSiRe1/ioBroker.espeasy-s0/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/BeSiRe1/ioBroker.espeasy-s0/actions/workflows/test-and-release.yml)

**Zuverlässiges Auslesen von S0-Energiezählern (z. B. Eltako DSZ12E, WSZ, DSZ15…) über einen ESP8266/ESP32 mit [ESPEasy](https://espeasy.readthedocs.io/).**

*English below.*

## Warum?

Der ESPEasy-Pulse-Counter zählt die S0-Impulse zuverlässig. Sein Wert `Total` ist aber **kein Zählerstand**: Nach einem Stromausfall, einem Neu-Flashen oder einem Reset fängt er wieder bei 0 an. Dieser Adapter nimmt deshalb nur die **Differenzen** zwischen zwei Abfragen und führt den Zählerstand selbst in ioBroker weiter.

- neustartsicher: ESP-Neustarts und Zähler-Resets werden erkannt, es gehen keine Impulse verloren
- Zählerstand auf den Wert des echten Zählers setzbar (`meter.setReading`)
- aktuelle Leistung in W, berechnet aus dem Impulsabstand
- Verbrauch heute, gestern, diesen Monat, letzten Monat, dieses Jahr, letztes Jahr
- Plausibilitätsfilter gegen Störimpulse
- Erreichbarkeit und Diagnose pro Gerät, mehrere Geräte pro Instanz
- keine Cloud und kein MQTT nötig, der Adapter fragt `http://<ESP>/json` direkt ab

## ESPEasy einrichten

1. Unter *Devices* einen Task **Generic - Pulse counter** anlegen
2. Verdrahtung: **S0+ an den GPIO, S0- an GND**. Den GPIO auswählen und *Internal PullUp* aktivieren.
3. **Counter Type:** `Delta/Total/Time`
4. **Mode Type:** `Falling`. Nicht `Change`, sonst werden pro Impuls zwei Flanken gezählt.
5. **Debounce Time:** kleiner als die Impulslänge des Zählers, z. B. **30 ms** (S0-Impulse sind laut Norm mindestens 30 ms lang, der Eltako DSZ12E liefert 65–90 ms)
6. Interval z. B. 2–10 s, Task aktivieren

Mit dem Adapter ist ein MQTT-Controller in ESPEasy nicht erforderlich. Ein vorhandener stört aber nicht.

## Adapter einrichten

| Feld | Bedeutung |
|---|---|
| Name | wird zur Objekt-ID, z. B. `Heizung` → `espeasy-s0.0.Heizung.*` |
| IP / Host | Adresse des ESP, z. B. `10.0.50.147` |
| ESPEasy-Taskname | Name des Pulse-Counter-Tasks; leer = erster Pulse-Counter |
| Impulse / kWh | steht auf dem Zähler, z. B. `800` beim Eltako DSZ12E |
| Wert 'Total' / 'Time' | Namen der Task-Werte, nur ändern, wenn in ESPEasy umbenannt |

Nach dem ersten Start den **Stand des echten Zählers** in `espeasy-s0.0.<Name>.meter.setReading` schreiben, z. B. `70002`. Ab dann zählt der Adapter weiter. Den Abgleich kannst du jederzeit wiederholen. Der laufende Tages-, Monats- und Jahresverbrauch ändert sich dadurch nicht.

## Datenpunkte

| Datenpunkt | Beschreibung |
|---|---|
| `meter.total_kWh` | Zählerstand in kWh |
| `meter.power_W` | aktuelle Leistung in W |
| `meter.setReading` | Zählerstand setzen (schreibbar) |
| `consumption.today_kWh` / `yesterday_kWh` | Verbrauch heute / gestern |
| `consumption.month_kWh` / `lastMonth_kWh` | Verbrauch dieser / letzter Monat |
| `consumption.year_kWh` / `lastYear_kWh` | Verbrauch dieses / letztes Jahr |
| `info.online` | ESP erreichbar |
| `info.lastUpdate` / `info.lastPulse` | Zeitpunkt der letzten Abfrage / des letzten Impulses |
| `info.espTotal` / `info.espUptime` | Rohwert und Laufzeit des ESP |
| `info.rebootCount` / `counterResetCount` / `rejectedCount` | Diagnose-Zähler |
| `internal.state` | gespeicherter Zustand, bitte nicht ändern |

## Grenzen

- Impulse, die der ESP zwischen der letzten Abfrage und einem **Stromausfall** gezählt hat, gehen verloren, maximal ein Abfrageintervall. Ein kürzeres Abfrageintervall verringert das.
- Fällt nur ioBroker oder das WLAN aus, zählt der ESP weiter. Der Adapter übernimmt die Impulse danach vollständig.
- Ist in ESPEasy ein Admin-Passwort gesetzt, muss `/json` ohne Anmeldung erreichbar sein (wird noch nicht unterstützt).

---

## English

Reliable reading of S0 energy meters through an ESPEasy *Generic - Pulse counter* task. The adapter polls `http://<esp>/json`, adds only the differences of the ESP's `Total` value to its own persistent counter, and therefore survives ESP reboots and counter resets. It provides the meter reading (kWh), current power (W), consumption for today, yesterday, month, last month, year and last year, a plausibility filter, and reachability and diagnostics.

ESPEasy settings: counter type `Delta/Total/Time`, mode type `Falling`, debounce below the meter's pulse length (e.g. 30 ms). In the adapter, configure the IP, task name and impulses per kWh. After the first start, write the reading of your physical meter to `meter.setReading`.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.1.0 (2026-11-17)
* (BeSiRe1) initial release

## License
MIT License

Copyright (c) 2026 BeSiRe1
