"""
Niederschlagsdashboard - precompute.py

Deutschland: laedt Stundenwerte-Niederschlag von DWD Open Data fuer eine
kuratierte Auswahl an Stationen (naheste Station je Stadt aus cities.py +
Auffuellung je Bundesland).

Frankreich: laedt Tageswerte-Niederschlag von Meteo-France (data.gouv.fr,
"Donnees climatologiques de base quotidiennes", ein CSV.gz pro Departement,
kein API-Key noetig) fuer eine kuratierte Auswahl an Staedten aus
cities_fr.py + Auffuellung je Departement.

Aggregiert beides zu Tagessummen (fuer Wochen/Monats/.../Dekaden-Ansicht),
Deutschland zusaetzlich zu Stundenwerten der letzten Tage (fuer die
"24h"-Ansicht - Frankreich liefert nur Tageswerte). Schreibt statische JSON-
Dateien nach docs/data/, die das Frontend per fetch() laedt. Kein Server
noetig (siehe skill_static_dashboard Pattern).
"""
import concurrent.futures
import csv
import gzip
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
from cities_fr import CITIES_FR

DE_BASE = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation"
DE_RECENT_DESC_URL = f"{DE_BASE}/recent/RR_Stundenwerte_Beschreibung_Stationen.txt"
DE_HIST_INDEX_URL = f"{DE_BASE}/historical/"
DE_RECENT_ZIP_TMPL = f"{DE_BASE}/recent/stundenwerte_RR_{{sid}}_akt.zip"
DE_HIST_ZIP_TMPL = f"{DE_BASE}/historical/{{fname}}"

FR_DATASET_API = "https://www.data.gouv.fr/api/1/datasets/6569b51ae64326786e4e8e1a/"
FR_DEPARTEMENTS_API = "https://geo.api.gouv.fr/departements"
FR_COMMUNE_API = "https://geo.api.gouv.fr/communes?lat={lat}&lon={lon}&fields=departement&format=json"

OUT_DIR = Path(__file__).parent.parent / "docs" / "data"
YEARS_HISTORY = 21           # Datenhistorie fuer Tageswerte (deckt Jahrzehnt-vs-Vorjahrzehnt-Vergleich)
HOURS_RECENT = 72            # Rohstunden fuer die DE-"24h"-Ansicht
MIN_STATIONS_PER_REGION = 8     # Mindestanzahl Stationen je Bundesland fuer Regionsmittel
FR_MIN_STATIONS_PER_REGION = 4  # Frankreich hat 95 (statt 16) Regionen -> kleinere Quote haelt daily.json handhabbar
FR_WORKERS = 8               # parallele Downloads ueber die franzoesischen Departements

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


# ---------------------------------------------------------------- Deutschland

def load_station_catalog():
    print("[DE] Lade Stationsverzeichnis ...")
    raw = fetch(DE_RECENT_DESC_URL).decode("latin1")
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
        if len(have) >= MIN_STATIONS_PER_REGION:
            continue
        pool = sorted(by_land.get(land, []))
        for sid in pool:
            if sid in used:
                continue
            used[sid] = candidates[sid]
            have.append(sid)
            if len(have) >= MIN_STATIONS_PER_REGION:
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
    print("[DE] Suche historische Archive ...")
    idx = fetch(DE_HIST_INDEX_URL).decode("latin1")
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
            hourly.update(parse_hourly_zip(fetch(DE_HIST_ZIP_TMPL.format(fname=hist_fname), timeout=60)))
        except Exception as e:
            print(f"  WARN {sid}: historisches Archiv fehlgeschlagen ({e})")
    try:
        hourly.update(parse_hourly_zip(fetch(DE_RECENT_ZIP_TMPL.format(sid=sid), timeout=60)))
    except Exception as e:
        print(f"  WARN {sid}: recent-Archiv fehlgeschlagen ({e})")

    cutoff = (today - timedelta(days=365 * YEARS_HISTORY)).strftime("%Y%m%d")
    daily = defaultdict(float)
    for ts, val in hourly.items():
        date = ts[:8]
        if date < cutoff:
            continue
        daily[date] += max(val, 0)

    return hourly, daily


def collect_germany(today):
    catalog = load_station_catalog()
    candidates = active_candidates(catalog, today)
    city_station, used_stations = select_stations(catalog, candidates)
    hist_map = find_hist_filenames(set(used_stations.keys()))

    daily_by_station = {}
    hourly_by_station = {}
    last_obs = None
    n = len(used_stations)
    for i, sid in enumerate(sorted(used_stations), 1):
        print(f"[DE {i}/{n}] Station {sid} ({used_stations[sid]['name']}) ...")
        hourly, daily = download_station_data(sid, hist_map.get(sid), today)
        if not hourly:
            continue
        hourly_by_station[sid] = hourly
        daily_by_station[sid] = daily
        latest_ts = max(hourly.keys())
        if last_obs is None or latest_ts > last_obs:
            last_obs = latest_ts

    valid = {sid: s for sid, s in used_stations.items() if sid in daily_by_station}
    city_station = {c: sid for c, sid in city_station.items() if sid in valid}

    stations_out = {
        sid: {"name": s["name"], "region": s["bundesland"], "lat": s["lat"], "lon": s["lon"]}
        for sid, s in valid.items()
    }
    return stations_out, city_station, daily_by_station, hourly_by_station, last_obs


# ----------------------------------------------------------------- Frankreich

def fr_resource_map():
    """{departement_code: {'hist': url, 'latest': url}} aus den Meteo-France-
    QUOT-Ressourcen (RR-T-Vent = Niederschlag/Temperatur/Wind); die genauen
    Zeitraum-Namen (z.B. 'previous-1950-2024') aendern sich jaehrlich, daher
    per Regex aus dem aktuellen Ressourcen-Titel gelesen statt hartkodiert."""
    print("[FR] Lade Ressourcenliste (data.gouv.fr) ...")
    data = json.loads(fetch(FR_DATASET_API, timeout=30).decode("utf-8"))
    out = {}
    # Titel-Schema: "QUOT_departement_<code>_periode_<zeitraum>_RR-T-Vent"
    # <zeitraum> ist z.B. "avant-1949" (zu alt, ignorieren), "1950-2024" (Historie,
    # Startjahr 1950 bleibt fix) oder "2025-2026" (die letzten ~2 Jahre).
    pat = re.compile(r"QUOT_departement_(\d{2})_periode_([\w-]+)_RR-T-Vent$")
    for r in data.get("resources", []):
        title = r.get("title", "")
        m = pat.match(title)
        if not m:
            continue
        code, period = m.groups()
        if period.startswith("avant"):
            continue
        kind = "hist" if period.startswith("1950") else "latest"
        out.setdefault(code, {})[kind] = r["url"]
    print(f"  {len(out)} Departements gefunden")
    return out


def fr_department_names():
    data = json.loads(fetch(FR_DEPARTEMENTS_API, timeout=20).decode("utf-8"))
    names = {d["code"]: d["nom"] for d in data}
    names["20"] = "Corse"  # Meteo-France gruppiert 2A+2B als "20"
    return names


def fr_city_departments():
    """Loest jede kuratierte Stadt per Koordinatensuche auf ihr Departement auf."""
    print("[FR] Loese Staedte-Departements auf ...")
    out = {}
    for name, lat, lon in CITIES_FR:
        try:
            url = FR_COMMUNE_API.format(lat=lat, lon=lon)
            data = json.loads(fetch(url, timeout=15).decode("utf-8"))
            code = data[0]["departement"]["code"] if data else None
            if code in ("2A", "2B"):
                code = "20"
            if code:
                out[name] = code
        except Exception as e:
            print(f"  WARN Departement-Lookup fuer {name} fehlgeschlagen ({e})")
    return out


def parse_fr_csv_gz(data):
    """liest ein Meteo-France QUOT-CSV.gz, gibt {NUM_POSTE: {name,lat,lon,daily}} zurueck."""
    text = gzip.decompress(data).decode("latin1")
    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    stations = {}
    for row in reader:
        sid = row.get("NUM_POSTE", "").strip()
        if not sid:
            continue
        st = stations.setdefault(sid, {
            "name": row.get("NOM_USUEL", "").strip().title(),
            "lat": float(row["LAT"]),
            "lon": float(row["LON"]),
            "daily": {},
        })
        rr = (row.get("RR") or "").strip()
        date = row.get("AAAAMMJJ", "").strip()
        if rr and date:
            try:
                st["daily"][date] = max(float(rr), 0)
            except ValueError:
                pass
    return stations


def process_fr_department(code, urls, city_coords, city_deps, cutoffs):
    cutoff_recent, cutoff_decade, cutoff_history = cutoffs
    stations = {}
    for kind in ("hist", "latest"):
        url = urls.get(kind)
        if not url:
            continue
        try:
            timeout = 90 if kind == "hist" else 30
            for sid, st in parse_fr_csv_gz(fetch(url, timeout=timeout)).items():
                if sid in stations:
                    stations[sid]["daily"].update(st["daily"])
                else:
                    stations[sid] = st
        except Exception as e:
            print(f"  WARN FR {code} ({kind}): {e}")

    candidates = {}
    for sid, st in stations.items():
        dates = st["daily"].keys()
        if not dates:
            continue
        if max(dates) >= cutoff_recent and min(dates) <= cutoff_decade:
            candidates[sid] = st

    city_matches = {}
    for name, dep in city_deps.items():
        if dep != code:
            continue
        clat, clon = city_coords[name]
        best_sid, best_d = None, None
        for sid, st in candidates.items():
            d = haversine(clat, clon, st["lat"], st["lon"])
            if best_d is None or d < best_d:
                best_sid, best_d = sid, d
        if best_sid:
            city_matches[name] = best_sid

    selected = set(city_matches.values())
    for sid in sorted(candidates):
        if len(selected) >= FR_MIN_STATIONS_PER_REGION:
            break
        selected.add(sid)

    result = {}
    for sid in selected:
        st = candidates.get(sid) or stations.get(sid)
        daily = {d: v for d, v in st["daily"].items() if d >= cutoff_history}
        if daily:
            result[sid] = {"name": st["name"], "lat": st["lat"], "lon": st["lon"], "daily": daily}

    return city_matches, result


def collect_france(today):
    resmap = fr_resource_map()
    dep_names = fr_department_names()
    # nur Metropole (01-95, "20"=Corse); Uebersee (971 etc.) und Sonder-Codes wie "99" ausschliessen
    codes = sorted(c for c in resmap if len(c) == 2 and c in dep_names)
    city_deps = fr_city_departments()
    city_coords = {name: (lat, lon) for name, lat, lon in CITIES_FR}

    cutoffs = (
        (today - timedelta(days=45)).strftime("%Y%m%d"),
        (today - timedelta(days=365 * 10)).strftime("%Y%m%d"),
        (today - timedelta(days=365 * YEARS_HISTORY)).strftime("%Y%m%d"),
    )

    city_station = {}
    stations_out = {}
    n = len(codes)
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=FR_WORKERS) as pool:
        futures = {
            pool.submit(process_fr_department, code, resmap[code], city_coords, city_deps, cutoffs): code
            for code in codes
        }
        for future in concurrent.futures.as_completed(futures):
            code = futures[future]
            done += 1
            region = dep_names.get(code, code)
            try:
                matches, selected = future.result()
            except Exception as e:
                print(f"[FR {done}/{n}] Departement {code} ({region}): FEHLER {e}")
                continue
            print(f"[FR {done}/{n}] Departement {code} ({region}): {len(selected)} Stationen")
            city_station.update(matches)
            for sid, info in selected.items():
                stations_out[sid] = {"name": info["name"], "region": region, "lat": info["lat"], "lon": info["lon"], "daily": info["daily"]}

    return stations_out, city_station


# --------------------------------------------------------------------- Utils

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


def write_json(name, obj):
    path = OUT_DIR / name
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  geschrieben: {path} ({path.stat().st_size / 1024:.0f} KB)")


def main():
    today = datetime.now(timezone.utc)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    de_stations, de_cities, de_daily_raw, de_hourly_raw, last_obs = collect_germany(today)
    fr_stations_raw, fr_cities = collect_france(today)

    all_dates = [d for daily in de_daily_raw.values() for d in daily.keys()]
    all_dates += [d for info in fr_stations_raw.values() for d in info["daily"].keys()]
    start_date = (today - timedelta(days=365 * YEARS_HISTORY)).date()
    end_date = datetime.strptime(max(all_dates), "%Y%m%d").date() if all_dates else today.date()

    de_daily_series = build_daily_series(de_daily_raw, start_date, end_date)
    fr_daily_series = build_daily_series({sid: info["daily"] for sid, info in fr_stations_raw.items()}, start_date, end_date)
    hourly_recent, hourly_start = build_recent_hours(de_hourly_raw, today)

    stations_out = {}
    for sid, s in de_stations.items():
        stations_out[f"DE-{sid}"] = {"name": s["name"], "country": "DE", "region": s["region"], "lat": s["lat"], "lon": s["lon"]}
    for sid, info in fr_stations_raw.items():
        stations_out[f"FR-{sid}"] = {"name": info["name"], "country": "FR", "region": info["region"], "lat": info["lat"], "lon": info["lon"]}

    cities_out = [{"name": name, "country": "DE", "stationId": f"DE-{sid}"} for name, sid in sorted(de_cities.items())]
    cities_out += [{"name": name, "country": "FR", "stationId": f"FR-{sid}"} for name, sid in sorted(fr_cities.items())]

    regions_out = {"DE": defaultdict(list), "FR": defaultdict(list)}
    for sid, s in de_stations.items():
        regions_out["DE"][s["region"]].append(f"DE-{sid}")
    for sid, info in fr_stations_raw.items():
        regions_out["FR"][info["region"]].append(f"FR-{sid}")
    regions_out = {c: {k: sorted(v) for k, v in sorted(r.items())} for c, r in regions_out.items()}

    daily_out = {f"DE-{sid}": arr for sid, arr in de_daily_series.items()}
    daily_out.update({f"FR-{sid}": arr for sid, arr in fr_daily_series.items()})

    hourly_out = {f"DE-{sid}": arr for sid, arr in hourly_recent.items()}

    meta = {
        "generated_at": today.isoformat(),
        "daily_start": start_date.strftime("%Y-%m-%d"),
        "daily_end": end_date.strftime("%Y-%m-%d"),
        "hourly_start": hourly_start,
        "last_observation": last_obs,
        "n_stations": len(stations_out),
        "n_stations_de": len(de_stations),
        "n_stations_fr": len(fr_stations_raw),
    }

    write_json("meta.json", meta)
    write_json("stations.json", stations_out)
    write_json("cities.json", cities_out)
    write_json("regions.json", regions_out)
    write_json("daily.json", daily_out)
    write_json("hourly_recent.json", hourly_out)

    print(f"Fertig: {len(de_stations)} DE- + {len(fr_stations_raw)} FR-Stationen, "
          f"Tageswerte {start_date}..{end_date}, letzte DE-Beobachtung {last_obs}")


if __name__ == "__main__":
    main()
