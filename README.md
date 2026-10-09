# Reisekasse Südostasien

Offline-fähiger Währungsrechner (PWA) für Thailand, Laos und Kambodscha.
Rechnet zwischen **EUR, THB (Baht), LAK (Kip), KHR (Riel)** und **USD** um.

- In ein beliebiges Feld tippen → alle anderen Währungen rechnen sofort mit.
- Schnellbeträge für typische Geldscheine der gerade aktiven Währung.
- Kurse werden online geladen (automatisch, wenn älter als 12 h, oder per Button).
  Quellen: [open.er-api.com](https://open.er-api.com), Fallback [fawazahmed0/currency-api](https://github.com/fawazahmed0/exchange-api).
- **⚙︎ Einstellungen:** pro Währung „manuell“ aktivieren und eigenen Kurs eintragen
  (z. B. den der Wechselstube). Manuelle Kurse werden beim Aktualisieren nicht überschrieben.
  Eingabe wahlweise als „1 EUR = … THB“ oder „1 THB = … EUR“.
- Komplett offline nutzbar: App-Dateien liegen im Service-Worker-Cache, Kurse im Gerätespeicher.

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

Nach Änderungen an den Dateien in `sw.js` die Version `CACHE = 'fx-v1'` hochzählen
(`fx-v2`, …), committen und pushen. Die App holt sich das Update beim nächsten Start mit Internet
(ggf. App einmal schließen und neu öffnen).
