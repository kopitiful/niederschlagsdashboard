# Niederschlagsdashboard

Niederschlag für Stadt, Bundesland/Département oder ganz Deutschland/Frankreich – 24 Stunden (nur DE), 7 Tage, Woche, Monat, Halbjahr, Jahreszeit, Jahr, Jahrzehnt oder freier Zeitraum, plus Vorjahres-/Vorjahrzehnt-Vergleich.

Daten:
- Deutschland: [DWD Open Data](https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation/) (Stundenwerte Niederschlag), 116 Stationen
- Frankreich: [Météo-France via data.gouv.fr](https://www.data.gouv.fr/datasets/donnees-climatologiques-de-base-quotidiennes/) (Tageswerte Niederschlag, ein CSV pro Département, kein API-Key), ~370 Stationen über alle 95 Metropole-Départements

## Architektur

Statische Seite, kein Server:

- `scripts/precompute.py` lädt DWD- und Météo-France-Daten, aggregiert zu Tages-/Stundenwerten und schreibt JSON nach `docs/data/`
- `.github/workflows/update.yml` läuft täglich per Cron und aktualisiert die Daten
- `docs/` wird per GitHub Pages **und** Cloudflare Pages (Git-Integration) ausgeliefert (reines HTML/JS + Chart.js, kein Framework)

## Lokal ausführen

```bash
python3 scripts/precompute.py
cd docs && python3 -m http.server 8000
```
