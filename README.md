# Reisekasse

Offline-fähiger Währungsrechner (PWA) für Reisen – mit den **100 wichtigsten Währungen** der Welt
(Liste in `currencies.js`).

- **Einstellungen** (Regler-Symbol oben rechts):
  - **Meine Währung:** die Währung von zu Hause (Standard: Euro). Darin rechnet die App alle Preise um.
  - **Länder hinzufügen oder entfernen:** die Reiseländer wählen, die man gerade braucht – mit Suche nach
    Land, Währung oder Code (z. B. „Bali“, „Dollar“, „JPY“). Die gewählten Länder erscheinen als Tabs im Rechner.
  - **Eigener Kurs:** pro Land z. B. den Kurs der Wechselstube eintragen. Eigene Kurse werden beim
    Aktualisieren nicht überschrieben und gelten für die jeweils eingestellte eigene Währung.
    Eingabe wahlweise als „1 € = … Landeswährung“ oder „1 Landeswährung = … €“.
- Oben das Reiseland wählen, Preis vor Ort eintippen → Ergebnis in der eigenen Währung.
  Der Pfeil-Knopf tauscht die Richtung. Bei vielen Ländern lässt sich die Tab-Leiste seitlich wischen.
- Eigene Zifferntastatur; bei Währungen ohne Nachkommastellen (Kip, Yen, Rupiah …) gibt es statt
  Komma eine **000**-Taste. Löschtaste lang drücken leert die Eingabe. Am Computer geht auch die normale Tastatur.
- Darunter die Beträge in den übrigen Reiseländern – antippen wechselt dorthin, der Wert bleibt gleich.
- Haben zwei gewählte Währungen dasselbe Symbol (z. B. „kr“ in Schweden und Norwegen), zeigt die App den Code (SEK, NOK).
- Schnellbeträge für typische Geldscheine, heller und dunkler Modus automatisch.
- Kurse werden online geladen (automatisch, wenn älter als 12 h, oder durch Antippen der Uhrzeit) – immer für
  alle 100 Währungen, damit später hinzugefügte Länder auch offline stimmen.
  Quellen: [open.er-api.com](https://open.er-api.com), Fallback [fawazahmed0/currency-api](https://github.com/fawazahmed0/exchange-api).
- Komplett offline nutzbar: App-Dateien liegen im Service-Worker-Cache, Kurse im Gerätespeicher.
  Für den allerersten Start ohne Internet sind Standardkurse eingebaut (Stand 10.10.2026).

## Lokal testen

```sh
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Auf GitHub Pages veröffentlichen

1. Auf github.com ein neues (öffentliches) Repository anlegen, z. B. `reisekasse`.
2. Im Projektordner:
   ```sh
   git remote add origin https://github.com/<DEIN-NAME>/reisekasse.git
   git push -u origin main
   ```
3. Im Repository: **Settings → Pages → Source: „Deploy from a branch“, Branch `main`, Ordner `/ (root)`** → Save.
4. Nach ca. 1 Minute ist die App unter `https://<DEIN-NAME>.github.io/reisekasse/` erreichbar.

## Aufs Handy installieren

- **iPhone (Safari):** Seite öffnen → Teilen-Symbol → „Zum Home-Bildschirm“.
- **Android (Chrome):** Seite öffnen → Menü ⋮ → „App installieren“ / „Zum Startbildschirm hinzufügen“.

Danach die App **einmal mit Internet öffnen** (lädt aktuelle Kurse und speichert alles für offline).
Test: Flugmodus an → App starten → muss funktionieren.

## Updates

Nach Änderungen an den Dateien in `sw.js` die Version `CACHE = 'fx-v3'` hochzählen
(`fx-v4`, …), committen und pushen. Die App holt sich das Update beim nächsten Start mit Internet
(ggf. App einmal schließen und neu öffnen).
