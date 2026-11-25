# RouteRider Tire Pressure Calculator — Build Guide (v0.1)

Diese Anleitung ist für Jonas gedacht, um den MVP mit Claude Code selbst zu bauen. Sie ergänzt drei andere Dokumente, die bei jeder Phase griffbereit sein sollten (liegen bereits im `docs/`-Ordner im Repo):

1. `RouteRider Tire Pressure.pdf` — das Haupt-Product-Sheet (Vision, Formeln, Scope)
2. `RouteRider Tire Pressure - Resolved Decisions D4-D7.md` — die zuvor offenen Kernentscheidungen (Tubeless-Logik, Map Matching, Safety Bounds, Surface Inference) plus D8 (Wheel Diameter Modifier, nachträglich ergänzt)
3. `RouteRider - Fueling Strategy v0.2 Spec (Design Preview).md` — nur zur Info, nicht Teil von v0.1

## 0. Voraussetzungen — Schritt für Schritt (Windows)

Da Jonas das zum ersten Mal macht, hier alles im Detail, in der Reihenfolge zum Abarbeiten. Jeder Schritt dauert nur ein paar Minuten.

### Schritt 1 — Node.js installieren

1. [nodejs.org](https://nodejs.org) öffnen.
2. Die **LTS-Version** für Windows herunterladen (`.msi`-Datei, 64-bit).
3. Installer mit Standardeinstellungen durchklicken ("Add to PATH" ist bereits gesetzt).
4. Bei Aufforderung neu starten.
5. In PowerShell prüfen:
   ```powershell
   node -v
   npm -v
   ```
   Beide sollten eine Versionsnummer zeigen (z. B. `v22.x.x`).

### Schritt 2 — Git installieren

1. [git-scm.com/downloads/win](https://git-scm.com/downloads/win) herunterladen und installieren (Standardwerte durchklicken — Git Bash wird automatisch mitinstalliert, das braucht Claude Code später).
2. Prüfen: `git --version`
3. Einmalig Name/E-Mail hinterlegen:
   ```powershell
   git config --global user.name "Jonas Salzsieder"
   git config --global user.email "jonas.salzsieder@googlemail.com"
   ```

### Schritt 3 — GitHub-Account

Auf [github.com](https://github.com) registrieren, falls noch nicht vorhanden.

### Schritt 4 — Vercel-Account

Auf [vercel.com](https://vercel.com) → "Sign Up" → **"Continue with GitHub"** (verknüpft beide Accounts automatisch für Phase 10).

### Schritt 5 — Claude Code installieren

Voraussetzung: bezahlter Claude-Plan (Pro/Max/Team/Enterprise) — der kostenlose claude.ai-Plan reicht nicht.

1. PowerShell öffnen.
2. Installieren:
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```
3. Prüfen: `claude --version`
4. In den Projektordner wechseln und starten:
   ```powershell
   cd Pfad\zu\deinem\routerider-Ordner
   claude
   ```
   Browser öffnet sich zum einmaligen Login.

### Schritt 6 — GitHub-Repository verbinden

**Wichtig:** `git commit` speichert nur lokal auf dem eigenen Rechner — nichts landet automatisch bei GitHub. Deshalb dieses Repo gleich jetzt verbinden (nicht erst in Phase 10 warten), damit jede Phase laufend gesichert wird.

1. Auf [github.com](https://github.com) → "+" → "New repository". Name vergeben (z. B. `routerider`), **kein** Häkchen bei README/.gitignore/license (der lokale Ordner hat das schon).
2. Im Projektordner ausführen (Werte durch die eigenen ersetzen):
   ```powershell
   git remote add origin https://github.com/DEIN-USERNAME/routerider.git
   git branch -M main
   git push -u origin main
   ```
3. Ab jetzt nach **jedem** `git commit` zusätzlich `git push` ausführen — siehe Abschnitt 2, Schritt 5.

## 1. Projekt aufsetzen

```bash
npx create-next-app@latest routerider --typescript --app --tailwind --eslint
cd routerider
git init
git add -A
git commit -m "chore: initial Next.js scaffold"
```

Danach `docs/`-Ordner anlegen und die drei oben genannten Dateien hineinlegen, `CLAUDE.md` im Projekt-Root mit Kontext erstellen, und Schritt 6 oben (GitHub-Repository verbinden) durchführen.

## 2. Arbeitsweise pro Phase

Für jede der folgenden Phasen gilt dasselbe Muster:

1. Claude-Code-Session im Projektordner starten.
2. Kurz beschreiben, welche Phase jetzt dran ist, mit Verweis auf die docs.
3. Bauen lassen.
4. **STOP → Test**: die Phase manuell im Browser ausprobieren (`npm run dev`, dann `localhost:3000`) — nicht überspringen.
5. Bei Erfolg: `git add -A && git commit -m "..."` **und danach `git push`** — ein Commit+Push pro funktionierender Phase.
6. Erst dann zur nächsten Phase.

## 3. Die Phasen im Detail

**Phase 0 — Projekt-Setup**: siehe oben. ✅ erledigt

**Phase 1 — GPX Upload + Parsing**: File Picker + Drag & Drop für `.gpx`, Koordinaten/Geometrie/Distanz/Elevation extrahieren. Test: mehrere echte GPX-Dateien (z. B. aus Komoot/Strava) hochladen, Plausibilität von Distanz/Höhenmeter prüfen. ✅ erledigt

**Phase 2 — Route Map + Route-Informationen**: Route auf Leaflet-Karte (OSM-Tiles), Dateiname/Distanz/Höhenmeter als UI. ✅ erledigt

**Phase 3 — Map Matching Prototyp**: Heuristik aus D5 (Resolved Decisions) umsetzen (Buffer-Suche + Richtung + Kontinuität gegen Overpass). **STOP → Test mit mehreren echten GPX-Routen** — technisch riskantester Teil des MVP. Bei sichtbar falscher Zuordnung an parallelen Wegen/Kreuzungen: Heuristik nachschärfen statt weiterbauen. ✅ erledigt (für normale Routenlängen bestätigt; siehe offene Punkte unten)

*Lessons Learned:*
- Die erste Version rief pro Segment einzeln Overpass auf und war bei längeren Routen zu langsam bzw. instabil (429/500/502/504-Fehler unter Last). Behoben durch gebündelte Overpass-Abfragen über die `around`-Filter-Query statt Bounding-Box pro Segment, plus Retry mit Backoff + Fallback-Mirror (`overpass.kumi.systems`), sequenziell (keine parallelen Chunk-Anfragen, das hatte zu stillen Teilausfällen geführt).
- **Root Cause für scheinbar zufällige Komplett-Ausfälle einzelner Routen gefunden:** Overpass hat ein eigenes internes Server-seitiges Timeout (~25-28s), das unabhängig von unserem Client-Timeout ist. Bei Überschreitung antwortet Overpass mit HTTP 200 und einem *leeren* `elements`-Array plus einem versteckten `remark`-Feld ("Query timed out") — wird jetzt als echter Fehler erkannt statt als stilles Nullergebnis.
- Bestätigt funktionierend: 18,9 km ländlich (Brandenburg) → 189 Segmente, 0 ohne Match; 57,4 km durch Berlin-Innenstadt → 826 Segmente/177 mehrdeutig/5 ohne Match.
- **Befund (2026-09-25):** Auch eine normale 110km-Route kann mit `429 Too Many Requests` scheitern (Chunk 2 von 6), wenn gleichzeitig der Fallback-Mirror überlastet ist. Root Cause laut [Overpass Fair Use Policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html): begrenzte Concurrent-Slots + lastabhängiges Cool-Down pro IP — bei mehreren Testrouten kurz hintereinander leicht überschritten. **Kein Randfall wie die >150km-Routen unten, sondern kann jede normale Bikepacking-Tagesdistanz treffen.** Sofortmaßnahme bei akutem 429: ein paar Minuten warten, erneut versuchen.

**Finale v0.1-Spezifikation für den Overpass-Umbau (2026-09-25, nach zwei Feedback-Runden abgestimmt, umzusetzen in 3 getrennten Commits — ergänzt um Commit 4, siehe unten):**

Kernidee: Query-Auflösung ≠ Matching-Auflösung — die Overpass-Anfrage bekommt eine vereinfachte Route, das Map Matching läuft weiterhin mit den vollständigen Original-GPX-Punkten. Bewusst konservativ gehalten (nicht gleichzeitig Matching-Logik, OSM-Filterung und Cache-Architektur anfassen):

- **Matching-Radius (D5) bleibt unverändert bei 20m** — nicht anfassen, gerade in dichten Gebieten wie Berlin würde ein breiterer Matching-Radius mehr parallele Kandidaten (Radwege, Nebenstraßen) heranziehen und die Mehrdeutigkeits-Quote verschlechtern.
- **Overpass-Query-Korridor auf ~40m** (nur für den Overpass-`around`-Filter, getrennt vom Matching-Radius): 20m Matching + 12m Douglas-Peucker-Toleranz + 8m Sicherheitsmarge = 40m. Falls Tests zeigen, dass das beim Fetching zu knapp ist: zuerst Query-Radius auf 50m erhöhen, NICHT das Matching verändern.
- **Douglas-Peucker-Vereinfachung mit ~12m Toleranz**, nur für die Overpass-Anfrage-Geometrie, vor dem Chunking. Original-GPX-Punkte bleiben für das lokale Matching unverändert vollständig erhalten (separates Array).
- **Chunking nach fixer Routenlänge**: ~50km pro Chunk statt Bounding-Box-Breiten-Heuristik, mit ~1km Overlap zwischen Chunks. Sicherheitsnetz bleibt die bestehende `remark`-Timeout-Erkennung: scheitert ein Chunk trotzdem, wird genau dieser eine Chunk halbiert und erneut versucht.
- **Tag-Filter**: nur Element-Filter auf `way[highway]` (Ways ohne highway-Tag werden gar nicht erst abgefragt) — kein zusätzliches Ausschließen einzelner highway-Werte (z.B. `construction` bleibt drin), um keine False Negatives bei ungewöhnlich getaggten, aber realen Wegen zu riskieren. Relevante Tags für die Weiterverarbeitung (D7-Inferenz): `highway`, `surface`, `tracktype`, `smoothness`, `bicycle`, `cycleway`, `mtb:scale`. Spätere, aggressivere Filterung erst nach echten Query-Statistiken aus der Praxis.
- **Cache: Exact-Query-Cache für v0.1** (kein räumliches Tile-Caching — das ist eine bewusst dokumentierte spätere Verbesserung, kein v0.1-Scope). Cache-Key wird von der tatsächlich generierten, normalisierten Overpass-Query abgeleitet (nicht vom rohen GPX), damit er auch nach dem DP-Schritt deterministisch funktioniert. Löst den unmittelbaren Fall: dieselbe/exakt gleiche Query wird nicht zweimal an Overpass geschickt.
- **HTTP 429 separat behandeln**: Backoff ~15-20s beim selben Primary-Server, bevor auf den Mirror gewechselt wird.

**Commit-Reihenfolge (bewusst getrennt, damit sich Probleme leicht isolieren/zurückrollen lassen):**
1. `D8` (Wheel Diameter Modifier, siehe unten bei Phase 6/7). ✅ erledigt (2026-09-25)
2. `Overpass 429 retry + exact query cache` — gegen die bestehende Chunking-Logik getestet (Chunk-Anzahl ändert sich hier noch nicht). ✅ erledigt (2026-09-25) — Cache verifiziert (zweiter Durchlauf 13ms statt 13,4s), 429-Backoff am selben Tag mehrfach live bestätigt.
3. `Adaptive route simplification + ~50km chunking` (Douglas-Peucker + neues Chunking + 40m-Korridor + Tag-Filter) — danach die Chunk-Reduktion sichtbar. ✅ erledigt (2026-09-25), inkl. Regression nach der remark-Änderung (siehe unten).
4. `Overpass multi-mirror failover` (konfigurierbare Endpoint-Liste inkl. `overpass.private.coffee`, siehe Abschnitt „Overpass-Resilienz" unten) — erst NACH Commit 3, damit sich Wirkung von weniger Requests und Wirkung von mehr Mirrors getrennt messen lassen. ⏳ gebaut, als `wip` auf Branch `feat/overpass-failover` gesichert (2026-11-25), Regression wegen Overpass-Totalausfall offen.
5. `Postpass fallback` (Stufe 2 im Abschnitt „Overpass-Resilienz“ unten), auf demselben Branch in zwei Commits: **5a** Schnittstelle `fetchWaysAlongRoute` + Overpass-Provider (reines Refactoring), **5b** Postpass-Provider. ⏳ geplant (2026-11-25)

*Testergebnisse Commit 3 (2026-09-25, vor der remark-Änderung; Match-Logik und Query seitdem unverändert):* 9,5km → 1 Chunk, 162 gematcht / 53 mehrdeutig / 0 ohne Match. 57,4km Grunewald → 2 Chunks à 28,5km, beide per remark-Timeout halbiert, 832 / 176 (17,5%) / 0 ohne Match (vorher 826 / 177 / 5 bei denselben 1008 Segmenten). Offline-Prüfung aller Testrouten: jedes Segment genau einmal abgedeckt, max. 11,9m Abstand zur Query-Linie, 192,8km → 4 statt 9 Chunks.

- **Adaptive chunking:** Routes are initially split into chunks of approximately 50 km. If Overpass returns a query-timeout remark, the affected chunk is immediately divided into smaller chunks without retrying the same oversized query on another endpoint. (Beobachtet: in der Berliner Innenstadt überschreiten schon ~28km-Chunks Overpass' 25s-Limit — 50km ist eine Obergrenze, keine Garantie.)
- **Regression nach remark-Änderung ✅ bestanden (2026-09-25, ~17:05 UTC):** 9,5km und Grunewald beide mit 0 ohne Match. Dabei alle Fehlerpfade live bestätigt: remark → sofortiges Halbieren nach 28s (vorher ~110s), remark erst beim Retry nach 504 → Mirror übersprungen, 504 → Retry OK ohne Splitten, 429 → 18s Backoff → Retry OK. (Vorherige Versuche 15:47–16:23 UTC waren durchgehend an HTTP 504/Serverlast gescheitert, eigene IP laut /api/status nicht gedrosselt.)

**Testrouten für Commit 3:** siehe zentrale Übersicht „Testrouten“ unten. (Historisch wurde Commit 3 auch mit der 9,5km-Stadtroute getestet — Ergebnisse oben bleiben als Protokoll stehen; als STOP→Test wird sie seit 2026-11-25 nicht mehr verwendet.) Lang (192,8km „Wochenende 2“): deutliche Request-Reduktion, sollte bei ~50km-Chunks ca. 4 statt bisher 9 Chunks brauchen; das ist zugleich der bisher offene >150km-Randfall unten.

**Hinweis zum Testen von Commit 2:** der 429-Backoff-Pfad lässt sich nicht zuverlässig auf Kommando auslösen — beim STOP→Test hier auf die Cache-Verifikation konzentrieren (dieselbe Route innerhalb derselben Browser-Session zweimal hochladen, zweiter Durchlauf sollte spürbar schneller sein/keine neuen Overpass-Requests erzeugen). Der 429-Pfad wird nur bei Gelegenheit real bestätigt.

- **Offener Punkt:** sehr lange Mehrtages-Routen (getestet: 192,8 km) sind noch nicht zuverlässig bestätigt — wird mit Commit 3 oben erneut getestet und möglicherweise aufgelöst. Bei weiterhin Timeouts: Eskalationsstufen im Abschnitt „Overpass-Resilienz" unten (Mirror-Failover → Postpass-Fallback; ein bezahlter Anbieter ist seit 2026-11-25 ausgeschlossen).
- **Long-route validation:** The 192.8 km test route could not yet be validated end-to-end due to repeated HTTP 504 and client-side timeouts during high Overpass server load. Chunking behavior and long-route reliability require an additional test under normal server conditions.

### Testrouten — zentrale Übersicht (Stand 2026-11-25)

Gilt für alle Änderungen an Overpass/Postpass, Map Matching oder Surface-Klassifizierung. Dateien in `RouteRider-test-routes/`. Die STOP→Tests der einzelnen Commits verweisen hierher.

| Rolle | Datei | Länge / Lage | Wann testen | Referenz (Segmente · Gematcht / Mehrdeutig / ohne Match) |
|---|---|---|---|---|
| **Standardtest** | `2026-09-16_3287885468_RouteRider Test.gpx` | 18,9km, ländlich (Brandenburg) | bei jeder Änderung, immer zuerst | 189 Segmente · ? / ? / **0** — Gematcht/Mehrdeutig beim ersten erfolgreichen Lauf eintragen (Datum + Quelle: Host bzw. `postpass`) |
| Stadt-Gegencheck | `2026-08-30_3243482460_Grunewald Forest – Teufelssee (Grunewald) loop from Boddinstraße.gpx` | 57,4km, Berlin Wald + Stadt | nur einmalig vor dem Merge des Postpass-Providers (5b), wegen `area=yes`-Ways | 1008 · 832 / 176 / 0 (2026-09-25, Overpass, nach Commit 3) |
| Langstreckentest | `2026-07-10_3098459414_Wochenende 2 - Nächte.gpx` | 192,8km, Berlin → Brandenburg | vor dem Merge von Commit 4 | noch keine (End-to-End offen); Log auswerten: Endpoint-Verteilung, Anzahl Requests (~4 Chunks erwartet) |

- **Nicht mehr getestet:** `2026-06-30_3074972624_Ali und Heim.gpx` (9,5km, reine Stadtroute — deckt den ländlichen Hauptanwendungsfall nicht ab). Historische Werte: 162 / 53 / 0 (2026-09-25, overpass-api.de), 161 / 54 / 0 (2026-11-25, kumi). `2026-09-17_3289048497_Test 2.gpx` (29,6km ländlich) hat keine Referenz und ist kein Pflichttest.
- **Regel:** Scheitert schon der Standardtest an Server-Last, die übrigen Routen nicht direkt hinterher testen, sondern später erneut versuchen.
- **Abweichungen:** ±1 Segment zwischen Gematcht und Mehrdeutig kann von einer anderen Datenquelle (Mirror, Postpass) oder geänderten OSM-Daten kommen — antwortenden Host im Server-Log notieren. Mehr Segmente „ohne Match“ gilt dagegen als Regression.

### Overpass-Resilienz — Mirror-Failover & Eskalationsstufen (2026-11-25)

**Kontext:** Die öffentlichen Overpass-Instanzen sind seit Monaten überlastet (siehe [OSM-Forum: Overpass API performance issues](https://community.openstreetmap.org/t/overpass-api-performance-issues/140598)). Die öffentlichen Instanzen werden privat/community-betrieben; für kommerzielle oder intensive Nutzung wird dort ausdrücklich auf eigene Instanz oder bezahlte Anbieter verwiesen. Deshalb Eskalation in Stufen — jede Stufe erst angehen, wenn die vorherige nachweislich nicht reicht. **Reihenfolge: Commit 2 → Commit 3 → Commit 4 (Stufe 1) → Stufe 2 (Bedarf am 2026-11-25 nachgewiesen, Commit 5a/5b). Stufe 3 (bezahlter Dienst) ist nicht geplant.**

- **Ausfallrisiko ohne SLA:** Beide Datenquellen — die öffentlichen Overpass-Instanzen und Postpass — sind kostenlose Community-Dienste ohne Garantie oder SLA. Fallen beide gleichzeitig aus, schlägt der Request mit einem Lastfehler fehl; die App zeigt dann eine Fehlermeldung, es gibt keine weitere Rückfallebene. Bewusst in Kauf genommen (kein bezahlter Dienst, siehe Stufe 3).

**Stufe 1 — Mirror-Failover (Commit 4, Umsetzung jetzt vorgesehen)**

Bewusst klein gehalten: nur die Endpoint-Auswahl und das Fehlerhandling erweitern, KEINE Änderung an Query-Aufbau, Chunking oder Matching.

- **Konfigurierbare Endpoint-Liste** statt hartkodierter Primary/Fallback-Mirror. Env-Variable `OVERPASS_ENDPOINTS` (kommagetrennt, in Priorität; Einträge getrimmt, ungültige URLs werden mit Log-Meldung verworfen; leer/ungesetzt → Default), Default:
  1. `https://overpass-api.de/api/interpreter` (Primary)
  2. `https://overpass.kumi.systems/api/interpreter` (bestehender Mirror)
  3. `https://overpass.private.coffee/api/interpreter` (neu; wirbt laut [Betreiberseite](https://osm.hpi.de/overpass/index.html) mit freiem Zugang ohne Rate-Limits, auch kommerziell nutzbar — **keine Garantie**, laut Forum läuft keine Alternativ-Instanz dauerhaft stabil)
- **Failover-Regeln pro Chunk** (weiterhin strikt sequenziell, keine parallelen Requests; 2026-11-25 abgestimmt, bestätigtes Verhalten aus Commit 2/3 bleibt erhalten):
  - Query-Timeout (HTTP 200 + leeres `elements` + `remark`) → sofort abbrechen, NICHT am nächsten Mirror wiederholen (dieselbe zu schwere Query wird dort nicht leichter); der Client halbiert genau diesen Chunk (Sicherheitsnetz aus Commit 3). **Kein Cool-Down** — ein Timeout heißt „Query zu schwer“, nicht „Server ungesund“.
  - `429` → ~18s Backoff + ein Retry **nur beim Primary**; bei allen anderen Endpoints und bei einem Primary im Cool-Down sofort weiter zum nächsten. Cool-Down: am Primary erst, wenn auch der Retry scheitert; bei anderen Endpoints sofort.
  - `500`/`502`/`504` → 3s-Retry **nur beim Primary** (live bestätigt: „504 → Retry OK“), danach nächster Endpoint; bei anderen Endpoints sofort weiter. Cool-Down beim Failover.
  - `503`, Netzwerkfehler, Client-Timeout → sofort nächster Endpoint, ohne Wartezeit. Cool-Down beim Failover.
  - Scheitern alle Endpoints an Last (nicht remark) → Fehler an den Nutzer, kein Halbieren.
- **Kurzer Cool-Down pro Endpoint:** Ein Endpoint, von dem wegen Last weitergeschaltet wurde (429, 5xx, Netzwerkfehler/Client-Timeout — nicht remark), wird für 60s ans Ende der Liste gestellt, nicht ausgeschlossen (In-Memory, best effort — auf Vercel Serverless nicht persistent, das ist für v0.1 ok). Eine erfolgreiche Antwort beendet den Cool-Down des Hosts sofort. Verhindert, dass jeder Chunk erneut zuerst den kaputten Server anfragt.
- **Logging:** Pro Request loggen, welcher Endpoint geantwortet hat und wie viele Fehlversuche davor lagen (Server-Log). Der antwortende Host steht zusätzlich im Response-Header `X-Overpass-Endpoint` (`cache` bei Cache-Treffer), sichtbar im Browser-Network-Tab. Das ist die Datengrundlage für die Entscheidung über Stufe 2/3.
- **Worst-Case-Dauer:** Mit 3 Endpoints (je 45s Client-Timeout) plus 18s-Backoff/Retry am Primary liegt ein einzelner Request im schlimmsten Fall bei über 2 Minuten. Lokal unkritisch; vor einem Deployment auf Vercel muss `maxDuration` der Route geprüft werden (jetzt bewusst nicht umgebaut).
- **Cache bleibt endpoint-unabhängig:** Der Exact-Query-Cache-Key aus Commit 2 darf den Endpoint NICHT enthalten (gleiche Query = gleiches Ergebnis, egal von welchem Mirror).
- **Datenqualität:** Mirrors können unterschiedlich aktuell sein. Für v0.1 akzeptiert, aber im Log festhalten, welcher Mirror geantwortet hat, falls Matching-Ergebnisse zwischen Läufen abweichen.

**STOP → Test für Commit 4** (Routen siehe zentrale Übersicht „Testrouten“ unten):
- Standardtest 18,9km läuft durch: 189 Segmente, 0 ohne Match (Regressionstest — Failover darf das Ergebnis nicht ändern); Gematcht/Mehrdeutig als Referenz in die Übersicht eintragen.
- Failover simulieren: temporär einen ungültigen Endpoint (z. B. `https://invalid.example/api/interpreter`) an die erste Stelle von `OVERPASS_ENDPOINTS` setzen → Route muss trotzdem durchlaufen, Log zeigt Wechsel auf den nächsten Endpoint.
- Vor dem Merge von Commit 4: Langstreckentest 192,8km und Log auswerten — welcher Endpoint hat wie oft geantwortet?
- Stand 2026-11-25: als `wip`-Commit auf Branch `feat/overpass-failover` gesichert (nicht gemergt); Failover-Pfade live bestätigt, Regressionszahlen wegen Overpass-Totalausfall noch offen.

**Stufe 2 — Postpass als Fallback hinter Overpass (Auslöser erfüllt 2026-11-25, Umsetzung als Commit 5a/5b auf `feat/overpass-failover`)**

- [Postpass](https://community.openstreetmap.org/t/hosted-osm-databases-as-a-service-accessible-via-api/141955) ist eine öffentliche OSM-PostGIS-Instanz von Geofabrik (SQL statt Overpass-QL), in der Community als Ausweich-Lösung genannt. Geofabrik-Aussage dazu: keine Garantien, Service noch relativ neu. Doku: [OSM-Wiki Postpass](https://wiki.openstreetmap.org/wiki/Postpass), [SCHEMA.md](https://github.com/woodpeck/postpass-ops/blob/main/SCHEMA.md).
- **Auslöser erfüllt am 2026-11-25 — Entscheidung: Postpass-Fallback wird gebaut.** Ausfalldaten: alle drei Overpass-Endpoints mindestens von 13:24 bis 16:35 UTC (> 3 h) praktisch nicht nutzbar; 1 von 9 Testläufen erfolgreich (9,5km über kumi), auch die leichte ländliche 18,9km-Route scheiterte mehrfach. `overpass-api.de`: HTTP 502 „server is currently at capacity … request queue is full“ (selbst bei `node(1)`), Hinweis im Fehlertext, dass der öffentliche Endpoint für browserbasierte/menschlich bediente Tools gedacht ist. `overpass.kumi.systems` und `overpass.private.coffee`: Startseite HTTP 200, aber Interpreter liefert selbst bei Minimal-Query 60–90s lang kein Byte (unabhängig vom User-Agent; private.coffee antwortete den ganzen Tag 0 von 8 Mal). Ein weiterer Mirror hilft nicht → Fallback mit anderer Technik.
- **Endpoint:** `https://postpass.geofabrik.de/api/interpreter` (der versionierte Pfad `/api/0.2/interpreter` antwortet mit HTTP 308 auf diesen Pfad). POST, Formularfeld `data` (bestätigt). Env-Variable `POSTPASS_ENDPOINT` (leer = Fallback aus).
- **Probe 2026-11-25 16:34 UTC** (während Overpass ausgefallen war): HTTP 200 in 0,09s. Antwortformat: GeoJSON `FeatureCollection` mit zusätzlichem `postpass_properties: { generator: "Postpass API 0.2", timestamp: "<Datenstand>" }` (Datenstand war ~3 min alt). Je Feature: `geometry` = `MultiLineString` mit `[lon, lat]`-Koordinaten (vollständige Way-Geometrie), `properties` = alle nicht-geometrischen SELECT-Spalten, hier `osm_id` (Zahl), `osm_type` (`"W"`), `tags` (JSON-Objekt mit **allen** Tags).
- **Datenmodell** (osm2pgsql-Flex, EPSG:4326, Tags als `jsonb`, Update alle 5 min): Ways in `postpass_line` (`osm_type` `'W'` oder `'R'` → auf `'W'` filtern, Overpass liefert auch nur Ways), Flächen in `postpass_polygon`. Distanzen in Metern nur über `::geography`; Index-Nutzung über `geom && <bbox>`-Vorfilter.
- **Umsetzung:**
  - **5a:** OSM-Datenzugriff hinter die Schnittstelle `fetchWaysAlongRoute(points, radiusMeters, requestId) → { data, source }` legen (`lib/osm/`), Overpass-Failover aus Commit 4 unverändert in einen Overpass-Provider verschieben — reines Refactoring, kein geändertes Verhalten. Entspricht der Vorgabe aus D5 (austauschbare Komponente).
  - **5b:** Postpass-Provider. Query: `postpass_line`, `osm_type='W'`, `tags ? 'highway'`, bbox-Vorfilter + `ST_DWithin(geom::geography, <Chunk-Linie>::geography, 40)` um dieselbe vereinfachte Chunk-Geometrie wie bei Overpass. Antwort wird ins Overpass-Format `{elements:[{type:"way", id, tags, geometry:[{lat,lon}]}]}` übersetzt, Tags über denselben Tag-Filter (7 Schlüssel). `lib/mapMatching.ts`, Cache-Schlüssel, Matching-Radius, Tag-Filter und Chunking bleiben unverändert.
- **Wann der Fallback greift:** erst wenn alle Overpass-Endpoints an Last scheitern (429, 5xx, Netzwerkfehler, Timeout) — **oder** direkt, wenn beim Start eines Requests alle Overpass-Endpoints im Cool-Down sind (spart pro Chunk ~93–138s). **Nicht** bei `remark`: dann wie bisher abbrechen, Client halbiert. Postpass: strikt ein Versuch, kein Retry; scheitert er, Lastfehler an den Nutzer. Quelle im Log und im Header `X-Overpass-Endpoint: postpass`. EXPLAIN-Endpoint nur einmalig während der Entwicklung (Queue-Einstufung der Query prüfen), nicht pro Request; öffentliche URL nicht dokumentiert.
- **Offene Datenlage (vor dem Merge klären bzw. beobachten):**
  - **Limits:** Rate-Limits, Timeouts, Concurrency pro IP, Fair-Use- und Nutzungsbedingungen sind in Wiki/README/SCHEMA **nicht dokumentiert**. Dokumentiert ist nur: 3 Queues, Kosten werden vorab geschätzt, kleine Queries dürfen große überholen. Eine Limits-Anfrage bei Geofabrik entfällt (Entscheidung 2026-11-25); die Limits werden nur über Beobachtung im Betrieb geklärt (Server-Log, Fehlercodes und Antwortzeiten von Postpass). Risiko: Postpass kann ebenfalls überlastet werden, wenn viele Overpass-Nutzer ausweichen.
  - **`area=yes`-Ways:** Geschlossene highway-Ways, die als Fläche getaggt sind (z. B. Fußgängerzonen `highway=pedestrian` + `area=yes`), landen bei osm2pgsql vermutlich in `postpass_polygon` statt `postpass_line` und würden dann fehlen, während Overpass sie liefert. Regel steht in `postpass.lua`, noch nicht geprüft. Vor allem in der Stadt relevant → Grunewald-Gegencheck; falls nötig `postpass_polygon` per `ST_Boundary` ergänzen.
  - Datenstand bis ~5 min alt (unkritisch); Abweichungen bei Gematcht/Mehrdeutig gegenüber Overpass sind als Datenunterschied zu werten, mehr „ohne Match“ dagegen als fehlende Wege.
- **STOP → Test für Postpass (5b):** zuerst 18,9km mit `OVERPASS_ENDPOINTS=https://invalid.example/api/interpreter` (erzwingt den Postpass-Pfad) → 189 Segmente, 0 ohne Match, Header/Log zeigen `postpass`. Danach einmalig Grunewald als Stadt-Gegencheck vor dem Merge (wegen `area=yes`-Ways; Vergleich mit 1008 / 832 / 176 / 0). Sobald Overpass wieder antwortet: dieselbe Chunk-Query an beide Quellen schicken und Way-IDs vergleichen (Skript außerhalb des Repos).

**Stufe 3 — Bezahlter Overpass-Dienst: nicht geplant (Entscheidung Jonas, 2026-11-25: kein bezahlter Dienst)**

*Die folgenden Preis- und Anfrageinformationen bleiben nur als Referenz stehen und werden **nicht verfolgt** (kein Kauf, keine Anfrage bei Geofabrik).*

- **Geofabrik Overpass API** ([Preise](https://www.geofabrik.de/data/overpass-api.html), netto): Small 10.000 Requests/Monat = 40 €/Monat, Medium 100.000 = 80 €, Large 1.000.000 = 160 €, XXL unbegrenzt ab 550 €. Bezahlung **ein Jahr im Voraus** (also mindestens 480 € Verpflichtung bei Small). Preise gelten unter der Annahme, dass Queries die Server nicht übermäßig belasten. Auf der Seite stehen keine Angaben zu Rate-Limits oder Timeouts → **vor dem Kauf per Kontaktformular nach SLA, Timeout-Limit und Abdeckung (Planet oder Extrakt) fragen.**
- **Mengengerüst:** Mit ~50km-Chunks sind es ca. 4 Requests pro 190km-Route (Cache senkt das weiter). Small (10.000 Requests) reicht damit rechnerisch für ~2.500 lange Routen im Monat.
- Alternative kommerzielle Option: MapLark (eigenes API/GeoJSON, keine Overpass-QL → Query-Umbau nötig, daher nicht erste Wahl).
- **Langfristig bei echtem Traffic:** eigener Overpass-Server oder PostGIS mit Geofabrik-Extrakt (Deutschland), auf kleinem eigenem Server (nicht auf Vercel lauffähig).
- **Ursprüngliche Entscheidungsregel (überholt):** Stufe 3 erst, wenn (a) Stufe 1+2 nicht reichen UND (b) die App über Testnutzung hinaus echte Nutzer hat oder Jonas die Ausfälle beim Testen nicht mehr tolerieren will. **Ersetzt durch die Entscheidung vom 2026-11-25: kein bezahlter Dienst.** Es bleibt bei Public-Infrastruktur laut Product Sheet Section 41 ("Infrastructure Principle"), mit dem oben beschriebenen Ausfallrisiko ohne SLA.

**Phase 4 — OSM Surface Analysis**: Klassifizierung Paved/Gravel/Trail/Unknown (Section 11) + Inference-Regeltabelle aus D7. ✅ erledigt — von Jonas als gut funktionierend bestätigt.

**Phase 5 — Confidence + manuelle Korrektur**: High/Medium/Low-Schwellen, Normalisierung bei Unknown (Section 15), Warnhinweis nur bei Low Confidence, editierbare Terrain-Verteilung. **Bewusst zurückgestellt** — Phase 6/7 hängen nicht davon ab (sie nutzen die rohen Paved/Gravel/Trail-Werte aus Phase 4 direkt), daher vorgezogen. Vor dem Release nachholen, spätestens vor Phase 9.

Hinweis aus den Phase-3-Tests: bei dichten Stadtrouten (z. B. Berlin-Innenstadt) lag der Anteil "mehrdeutig" bei ca. 21% (177 von 826 Segmenten) — das ist ein plausibler, erwarteter Wert laut D5, sollte aber bei der Confidence-Kalibrierung hier gegengeprüft werden, damit solche Routen nicht fälschlich als "High Confidence" durchgehen.

**Phase 6 — Bike Setup + Ride Type**: Gewichte, Reifenbreite vorne/hinten, Tube/Tubeless, Ride-Type-Presets mit editierbarer Front/Rear-Verteilung (45/55, 47/53, 40/60). Gebaut, Werte fließen sichtbar korrekt in Phase 7 ein. **Formale Einzelbestätigung des STOP→Tests steht noch aus** (Presets/manuelle Verteilung explizit durchklicken), kein Blocker — bei Gelegenheit nachholen.

**Nachtrag (D8): ✅ erledigt (2026-09-25).** Bike Setup hat einen zusätzlichen Input für den Laufraddurchmesser bekommen (700c/29" · 650b/27,5" · 26") — siehe D8 in den Resolved Decisions.

**Phase 7 — Pressure Engine**: Berto-Formel + Terrain-Modifier + Tubeless-/Safety-Bounds-Logik aus D4/D6. Safety-Bounds-Tabelle recherchiert und in D6 dokumentiert (siehe Resolved-Decisions-Datei). ✅ erledigt — Kalibrierungstest gegen SILCA bestanden.

*Kalibrierungstest-Ergebnis (2026-09-24):* Bei identischem Gesamtgewicht (83kg) und Reifenbreite (42/43mm), Tube, war RouteRiders Ergebnis nur ~1-2% von SILCA entfernt (Front: 33,4-33,5 psi vs. SILCA 34 psi; Rear: 35,8-36,3 psi vs. SILCA 35,5 psi) — sehr gute Übereinstimmung für eine bewusst vereinfachte Formel. Zusatzbeobachtung: SILCAs Tubeless-Option senkt den Druck direkt (34/32,5 psi), RouteRider verändert laut D4 bewusst nur die Sicherheits-Untergrenze, nicht die Basisempfehlung — bekannter, gewollter Unterschied. SILCAs feinere Gravel-Rauheit-Kategorien (1-4) zeigen eine plausible Druckspanne (30,5-35,5 psi je nach Rauheit), die RouteRiders pauschaler Gravel-Faktor (0,90) für v0.1 angemessen abdeckt (feinere Roughness-Unterscheidung ist laut Abschnitt 4 bewusst außerhalb des v0.1-Scopes).

**Nachtrag (D8): ✅ erledigt (2026-09-25).** Die Pressure Engine hat eine zusätzliche Modifier-Stufe für den Laufraddurchmesser bekommen, angewendet NACH dem Terrain-Modifier und VOR dem D6-Safety-Bounds-Clamp (700c/29" = Referenz/0%, 650b/27,5" = +5%, 26" = +8%) — siehe D8 in den Resolved Decisions für Begründung und Quellen. **Formale STOP→Test-Bestätigung (Ergebnis bei 26" spürbar aber leicht höher als bei 700c) steht noch aus, kein Blocker.**

**Zusatz (aus Phase 8 vorgezogen):** PSI/BAR-Toggle für die Druckanzeige (Segmented Control, Umrechnung 1 bar = 14.5038 psi, Akzentfarbe Moosgrün für aktiven Zustand). ✅ erledigt und im Einsatz (sichtbar in den Kalibrierungstest-Screenshots).

**Phase 8 — Result Screen**: Front/Rear-Anzeige (PSI/BAR-Toggle bereits vorgezogen und funktionierend, siehe Phase 7), "Warum dieser Druck?"-Aufklapper, Transparenz-Disclaimer (Section 36). Design-Referenz: siehe Abschnitt 5 unten. ← aktuell

**Phase 9 — Mobile-Optimierung**: kompletten Flow auf echtem Smartphone testen (nicht nur DevTools-Emulation).

**Phase 10 — Deployment**: Da GitHub bereits seit Schritt 6 verbunden ist, hier nur noch auf vercel.com das Repo importieren (Next.js wird automatisch erkannt, kein weiteres Setup nötig).

## 4. Was NICHT in v0.1 gehört

Laut Product Sheet Section 42 explizit ausgeschlossen: Weather-Anpassung, feinere Surface-Roughness, User Accounts, Datenbank, Strava/Komoot-Integration, Routenplanung, Navigation, POIs, **Fueling** (kommt als v0.2), Social Features, native Apps. Räumliches Tile-Caching für Overpass (siehe oben) ebenfalls bewusst auf später verschoben. **Bewusst ausgeschlossen: bezahlter Overpass-Dienst** (Stufe 3 im Abschnitt „Overpass-Resilienz“; Entscheidung Jonas, 2026-11-25 — kein bezahlter Dienst, auch nicht bei weiteren Ausfällen). (Der Postpass-Fallback, Stufe 2, wurde am 2026-11-25 nach nachgewiesenem Bedarf in v0.1 aufgenommen.)

## 5. Design

Finale Richtung (Konzept "Trail"): **warmes Off-White, schwarz-weiß mit einem Moosgrün-Akzent, ruhig und reduziert** — Hintergrund `#FAF9F6`, Text nahezu Schwarz `#1A1A1A`, Akzentfarbe Moosgrün `#3F6B4A` ausschließlich für Buttons, Links und aktive Zustände (PSI/BAR-Toggle, Confidence-Badge) — nie als Fließtextfarbe. Logotype als Serife (Fraunces, klein/kursiv gesetzt), UI- und Fließtext in Work Sans. Karten und Buttons abgerundet (12–16px Radius, CTA als Pill-Button). Terrain-Mix (Asphalt/Gravel/Trail) weiterhin über Graustufen dargestellt (hell = glatt, dunkel = rau), nicht über Farbe.

Von drei explorierten Richtungen (Signal/Orange-technisch, Trail/Grün-warm, Electric/Blau-dark) hat sich Jonas für **Trail** entschieden. Der komplette Design-Explorations-Canvas (alle 3 Konzepte, je Upload- und Result-Screen, klickbarer PSI/BAR-Toggle) liegt als Claude-Artifact vor: https://claude.ai/artifact/XQeNRKEEzvA2Zi6G4Hqx2Q — bei Phase 8 (Result Screen) und den übrigen UI-Phasen als visuelle Referenz für Claude Code nutzen (Screenshot oder Beschreibung der "Trail"-Komponenten mitgeben, inkl. der Farbwerte oben).
