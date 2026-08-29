# Grössere deutsche Städte mit Koordinaten (WGS84), gruppiert nach Bundesland.
# Dient nur zur Zuordnung "Stadt -> naechstgelegene DWD-Station" im precompute-Skript.
CITIES = [
    # (Name, Bundesland, lat, lon)
    ("Stuttgart", "Baden-Württemberg", 48.7758, 9.1829),
    ("Mannheim", "Baden-Württemberg", 49.4875, 8.4660),
    ("Karlsruhe", "Baden-Württemberg", 49.0069, 8.4037),
    ("Freiburg im Breisgau", "Baden-Württemberg", 47.9990, 7.8421),
    ("Heilbronn", "Baden-Württemberg", 49.1427, 9.2109),
    ("Ulm", "Baden-Württemberg", 48.4011, 9.9876),
    ("Heidelberg", "Baden-Württemberg", 49.3988, 8.6724),
    ("Pforzheim", "Baden-Württemberg", 48.8922, 8.6946),
    ("Reutlingen", "Baden-Württemberg", 48.4914, 9.2043),

    ("München", "Bayern", 48.1351, 11.5820),
    ("Nürnberg", "Bayern", 49.4521, 11.0767),
    ("Augsburg", "Bayern", 48.3705, 10.8978),
    ("Würzburg", "Bayern", 49.7913, 9.9534),
    ("Regensburg", "Bayern", 49.0134, 12.1016),
    ("Ingolstadt", "Bayern", 48.7665, 11.4257),
    ("Fürth", "Bayern", 49.4771, 10.9886),
    ("Bayreuth", "Bayern", 49.9427, 11.5764),
    ("Passau", "Bayern", 48.5665, 13.4319),
    ("Kempten", "Bayern", 47.7267, 10.3182),

    ("Berlin", "Berlin", 52.5200, 13.4050),

    ("Potsdam", "Brandenburg", 52.3906, 13.0645),
    ("Cottbus", "Brandenburg", 51.7563, 14.3329),
    ("Brandenburg an der Havel", "Brandenburg", 52.4125, 12.5316),
    ("Frankfurt (Oder)", "Brandenburg", 52.3474, 14.5502),

    ("Bremen", "Bremen", 53.0793, 8.8017),
    ("Bremerhaven", "Bremen", 53.5396, 8.5809),

    ("Hamburg", "Hamburg", 53.5511, 9.9937),

    ("Frankfurt am Main", "Hessen", 50.1109, 8.6821),
    ("Wiesbaden", "Hessen", 50.0782, 8.2398),
    ("Kassel", "Hessen", 51.3127, 9.4797),
    ("Darmstadt", "Hessen", 49.8728, 8.6512),
    ("Offenbach am Main", "Hessen", 50.1055, 8.7761),
    ("Gießen", "Hessen", 50.5841, 8.6779),
    ("Fulda", "Hessen", 50.5558, 9.6808),

    ("Rostock", "Mecklenburg-Vorpommern", 54.0887, 12.1400),
    ("Schwerin", "Mecklenburg-Vorpommern", 53.6355, 11.4012),
    ("Neubrandenburg", "Mecklenburg-Vorpommern", 53.5577, 13.2593),
    ("Stralsund", "Mecklenburg-Vorpommern", 54.3097, 13.0818),

    ("Hannover", "Niedersachsen", 52.3759, 9.7320),
    ("Braunschweig", "Niedersachsen", 52.2689, 10.5268),
    ("Osnabrück", "Niedersachsen", 52.2799, 8.0472),
    ("Oldenburg", "Niedersachsen", 53.1435, 8.2146),
    ("Göttingen", "Niedersachsen", 51.5413, 9.9158),
    ("Wolfsburg", "Niedersachsen", 52.4227, 10.7865),
    ("Hildesheim", "Niedersachsen", 52.1508, 9.9511),
    ("Lüneburg", "Niedersachsen", 53.2461, 10.4116),

    ("Köln", "Nordrhein-Westfalen", 50.9375, 6.9603),
    ("Düsseldorf", "Nordrhein-Westfalen", 51.2277, 6.7735),
    ("Dortmund", "Nordrhein-Westfalen", 51.5136, 7.4653),
    ("Essen", "Nordrhein-Westfalen", 51.4556, 7.0116),
    ("Duisburg", "Nordrhein-Westfalen", 51.4344, 6.7623),
    ("Bochum", "Nordrhein-Westfalen", 51.4818, 7.2162),
    ("Wuppertal", "Nordrhein-Westfalen", 51.2562, 7.1508),
    ("Bielefeld", "Nordrhein-Westfalen", 52.0302, 8.5325),
    ("Bonn", "Nordrhein-Westfalen", 50.7374, 7.0982),
    ("Münster", "Nordrhein-Westfalen", 51.9607, 7.6261),
    ("Aachen", "Nordrhein-Westfalen", 50.7753, 6.0839),
    ("Paderborn", "Nordrhein-Westfalen", 51.7189, 8.7575),
    ("Siegen", "Nordrhein-Westfalen", 50.8748, 8.0243),

    ("Mainz", "Rheinland-Pfalz", 49.9929, 8.2473),
    ("Ludwigshafen am Rhein", "Rheinland-Pfalz", 49.4741, 8.4453),
    ("Koblenz", "Rheinland-Pfalz", 50.3569, 7.5890),
    ("Trier", "Rheinland-Pfalz", 49.7499, 6.6371),
    ("Kaiserslautern", "Rheinland-Pfalz", 49.4401, 7.7491),

    ("Saarbrücken", "Saarland", 49.2401, 6.9969),

    ("Leipzig", "Sachsen", 51.3397, 12.3731),
    ("Dresden", "Sachsen", 51.0504, 13.7373),
    ("Chemnitz", "Sachsen", 50.8278, 12.9214),
    ("Zwickau", "Sachsen", 50.7189, 12.4941),

    ("Magdeburg", "Sachsen-Anhalt", 52.1205, 11.6276),
    ("Halle (Saale)", "Sachsen-Anhalt", 51.4964, 11.9683),
    ("Dessau-Roßlau", "Sachsen-Anhalt", 51.8377, 12.2493),

    ("Kiel", "Schleswig-Holstein", 54.3233, 10.1228),
    ("Lübeck", "Schleswig-Holstein", 53.8655, 10.6866),
    ("Flensburg", "Schleswig-Holstein", 54.7937, 9.4464),

    ("Erfurt", "Thüringen", 50.9848, 11.0299),
    ("Jena", "Thüringen", 50.9271, 11.5892),
    ("Gera", "Thüringen", 50.8804, 12.0813),
]

BUNDESLAENDER = sorted(set(b for _, b, _, _ in CITIES))
