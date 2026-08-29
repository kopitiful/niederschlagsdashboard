"""
Niederschlagsdashboard - precompute.py

Laedt Stundenwerte-Niederschlag von DWD Open Data fuer eine kuratierte Auswahl
an Stationen (naheste Station je Stadt aus cities.py + Auffuellung je
Bundesland), aggregiert sie zu Tagessummen (fuer Wochen/Monats/.../Dekaden-
Ansicht) und haelt die letzten Stunden separat vor (fuer die "24h"-Ansicht).
Schreibt statische JSON-Dateien nach docs/data/, die das Frontend per fetch()
laedt. Kein Server noetig (siehe skill_static_dashboard Pattern).
"""
import csv
import io
import json
import math
import re
import ssl
import sys
import urllib.request
import zipfile

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from cities import CITIES, BUNDESLAENDER

BASE = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation"
RECENT_DESC_URL = f"{BASE}/recent/RR_Stundenwerte_Beschreibung_Stationen.txt"
HIST_INDEX_URL = f"{BASE}/historical/"
RECENT_ZIP_TMPL = f"{BASE}/recent/stundenwerte_RR_{{sid}}_akt.zip"
HIST_ZIP_TMPL = f"{BASE}/historical/{{fname}}"

OUT_DIR = Path(__file__).parent.parent / "docs" / "data"
YEARS_HISTORY = 12          # Datenhistorie fuer Tageswerte (deckt "Jahrzehnt" mit Puffer)
HOURS_RECENT = 72           # Rohstunden fuer die "24h"-Ansicht
MIN_STATIONS_PER_LAND = 8   # Mindestanzahl Stationen je Bundesland fuer Regionsmittel

UA = {"User-Agent": "niederschlagsdashboard/1.0 (+https://github.com/kopitiful)"}


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return r.read()


def haversine(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def load_station_catalog():
    print("Lade Stationsverzeichnis ...")
    raw = fetch(RECENT_DESC_URL).decode("latin1")
    lines = raw.splitlines()[2:]
    stations = {}
    # fuehrende Zahlenfelder per Regex, Rest (Name/Bundesland/Abgabe) von rechts aufteilen,
    # da Stationsname Leerzeichen enthalten kann, Bundesland/Abgabe aber nicht.
    head_re = re.compile(
        r"^\s*(\d+)\s+(\d{8})\s+(\d{8})\s+(-?\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$"
    )
    for line in lines:
        line = line.rstrip()
        if not line:
            continue
        m = head_re.match(line)
        if not m:
            continue
        sid, von, bis, hoehe, lat, lon, rest = m.groups()
        tail = rest.split()
        if not tail:
            continue
        if tail[-1] in ("Frei", "geschlossen"):
            land = tail[-2] if len(tail) >= 2 else tail[-1]
        else:
            land = tail[-1]
        name = rest[: rest.rfind(land)].strip()
        stations[sid.zfill(5)] = {
            "id": sid.zfill(5),
            "von": von,
            "bis": bis,
            "lat": float(lat),
            "lon": float(lon),
            "name": name,
            "bundesland": land,
        }
    print(f"  {len(stations)} Stationen im Verzeichnis")
    return stations


def active_candidates(stations, today):
    cutoff_recent = (today - timedelta(days=45)).strftime("%Y%m%d")
    cutoff_decade = (today - timedelta(days=365 * 10)).strftime("%Y%m%d")
    cands = {
        sid: s
        for sid, s in stations.items()
        if s["bis"] >= cutoff_recent and s["von"] <= cutoff_decade
    }
    print(f"  {len(cands)} aktive Stationen mit >=10 Jahren Historie")
    return cands


def select_stations(stations, candidates):
    city_station = {}
    used = {}

    for name, land, lat, lon in CITIES:
        best_sid, best_d = None, None
        for sid, s in candidates.items():
            d = haversine(lat, lon, s["lat"], s["lon"])
            if best_d is None or d < best_d:
                best_sid, best_d = sid, d
        if best_sid:
            city_station[name] = best_sid
            used[best_sid] = candidates[best_sid]

    by_land = defaultdict(list)
    for sid, s in candidates.items():
        by_land[s["bundesland"]].append(sid)

    for land in BUNDESLAENDER:
        have = [sid for sid in used if used[sid]["bundesland"] == land]
        if len(have) >= MIN_STATIONS_PER_LAND:
            continue
        pool = sorted(by_land.get(land, []))
        for sid in pool:
            if sid in used:
                continue
            used[sid] = candidates[sid]
            have.append(sid)
            if len(have) >= MIN_STATIONS_PER_LAND:
                break

    print(f"  {len(used)} Stationen ausgewaehlt (Staedte + Bundesland-Auffuellung)")
    return city_station, used


def parse_hourly_zip(data):
    """liest ein DWD-Stundenwerte-ZIP, gibt dict {YYYYMMDDHH: mm} zurueck."""
    out = {}
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        prod = next(n for n in zf.namelist() if n.startswith("produkt_"))
        with zf.open(prod) as f:
            text = io.TextIOWrapper(f, encoding="latin1")
            reader = csv.DictReader(text, delimiter=";")
            reader.fieldnames = [h.strip() for h in reader.fieldnames]
            for row in reader:
                row = {k.strip(): v for k, v in row.items()}
                ts = row["MESS_DATUM"].strip()
                try:
                    val = float(row["R1"].strip())
                except (KeyError, ValueError):
                    val = None
                if val is not None and val >= 0:
                    out[ts] = val
    return out


def find_hist_filenames(sids):
    print("Suche historische Archive ...")
    idx = fetch(HIST_INDEX_URL).decode("latin1")
    mapping = {}
    for m in re.finditer(r'href="(stundenwerte_RR_(\d{5})_\d{8}_\d{8}_hist\.zip)"', idx):
        fname, sid = m.group(1), m.group(2)
        if sid in sids:
            mapping[sid] = fname
    return mapping


def download_station_data(sid, hist_fname, today):
    hourly = {}
    if hist_fname:
        try:
            hourly.update(parse_hourly_zip(fetch(HIST_ZIP_TMPL.format(fname=hist_fname), timeout=60)))
        except Exception as e:
            print(f"  WARN {sid}: historisches Archiv fehlgeschlagen ({e})")
    try:
        hourly.update(parse_hourly_zip(fetch(RECENT_ZIP_TMPL.format(sid=sid), timeout=60)))
    except Exception as e:
        print(f"  WARN {sid}: recent-Archiv fehlgeschlagen ({e})")

    cutoff = (today - timedelta(days=365 * YEARS_HISTORY)).strftime("%Y%m%d")
    daily = defaultdict(float)
    daily_has_data = defaultdict(bool)
    for ts, val in hourly.items():
        date = ts[:8]
        if date < cutoff:
            continue
        daily[date] += max(val, 0)
        daily_has_data[date] = True

    return hourly, daily


def build_daily_series(daily_by_station, start_date, end_date):
    ndays = (end_date - start_date).days + 1
    out = {}
    for sid, daily in daily_by_station.items():
        arr = [None] * ndays
        for date_str, val in daily.items():
            d = datetime.strptime(date_str, "%Y%m%d").date()
            idx = (d - start_date).days
            if 0 <= idx < ndays:
                arr[idx] = round(val, 1)
        out[sid] = arr
    return out


def build_recent_hours(hourly_by_station, today):
    end = today.replace(hour=0, minute=0, second=0, microsecond=0)
    hours = [(end - timedelta(hours=i)) for i in range(HOURS_RECENT, -1, -1)]
    out = {}
    for sid, hourly in hourly_by_station.items():
        arr = []
        for h in hours:
            key = h.strftime("%Y%m%d%H")
            v = hourly.get(key)
            arr.append(round(v, 1) if v is not None else None)
        out[sid] = arr
    return out, hours[0].strftime("%Y-%m-%dT%H:00")


def main():
    today = datetime.now(timezone.utc)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    catalog = load_station_catalog()
    candidates = active_candidates(catalog, today)
    city_station, used_stations = select_stations(catalog, candidates)
    hist_map = find_hist_filenames(set(used_stations.keys()))

    daily_by_station = {}
    hourly_by_station = {}
    last_obs = None
    n = len(used_stations)
    for i, sid in enumerate(sorted(used_stations), 1):
        print(f"[{i}/{n}] Station {sid} ({used_stations[sid]['name']}) ...")
        hourly, daily = download_station_data(sid, hist_map.get(sid), today)
        if not hourly:
            continue
        hourly_by_station[sid] = hourly
        daily_by_station[sid] = daily
        latest_ts = max(hourly.keys())
        if last_obs is None or latest_ts > last_obs:
            last_obs = latest_ts

    valid_stations = {sid: s for sid, s in used_stations.items() if sid in daily_by_station}
    city_station = {c: sid for c, sid in city_station.items() if sid in valid_stations}

    all_dates = [d for daily in daily_by_station.values() for d in daily.keys()]
    start_date = (today - timedelta(days=365 * YEARS_HISTORY)).date()
    end_date = datetime.strptime(max(all_dates), "%Y%m%d").date() if all_dates else today.date()

    daily_series = build_daily_series(daily_by_station, start_date, end_date)
    hourly_recent, hourly_start = build_recent_hours(hourly_by_station, today)

    stations_out = {
        sid: {
            "name": s["name"],
            "bundesland": s["bundesland"],
            "lat": s["lat"],
            "lon": s["lon"],
        }
        for sid, s in valid_stations.items()
    }

    bundesland_stations = defaultdict(list)
    for sid, s in valid_stations.items():
        bundesland_stations[s["bundesland"]].append(sid)

    meta = {
        "generated_at": today.isoformat(),
        "daily_start": start_date.strftime("%Y-%m-%d"),
        "daily_end": end_date.strftime("%Y-%m-%d"),
        "hourly_start": hourly_start,
        "last_observation": last_obs,
        "n_stations": len(valid_stations),
    }

    write_json("meta.json", meta)
    write_json("stations.json", stations_out)
    write_json("cities.json", dict(sorted(city_station.items())))
    write_json("bundeslaender.json", {k: sorted(v) for k, v in sorted(bundesland_stations.items())})
    write_json("daily.json", daily_series)
    write_json("hourly_recent.json", hourly_recent)

    print(f"Fertig: {len(valid_stations)} Stationen, Tageswerte {start_date}..{end_date}, letzte Beobachtung {last_obs}")


def write_json(name, obj):
    path = OUT_DIR / name
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  geschrieben: {path} ({path.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
