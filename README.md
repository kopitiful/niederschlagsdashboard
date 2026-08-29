# Niederschlagsdashboard

Niederschlag für Stadt, Bundesland oder ganz Deutschland – 24 Stunden, 7 Tage, Woche, Monat, Halbjahr, Jahreszeit, Jahr, Jahrzehnt oder freier Zeitraum.

Daten: [DWD Open Data](https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation/) (Stundenwerte Niederschlag), 116 Stationen.

## Architektur

Statische Seite, kein Server:

- `scripts/precompute.py` lädt DWD-Stationsdaten, aggregiert zu Tages-/Stundenwerten und schreibt JSON nach `docs/data/`
- `.github/workflows/update.yml` läuft täglich per Cron und aktualisiert die Daten
- `docs/` wird per GitHub Pages ausgeliefert (reines HTML/JS + Chart.js, kein Framework)

## Lokal ausführen

```bash
python3 scripts/precompute.py
cd docs && python3 -m http.server 8000
```
