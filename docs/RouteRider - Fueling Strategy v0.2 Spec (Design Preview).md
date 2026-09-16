---
Ergänzung zu: RouteRider Tire Pressure – Living Product & Build Document (v0.4 Draft)
Status: Design entschieden, Build für v0.2 (nach Launch des Tire Pressure Calculators)
Zweck: Hält fest, wie die Fueling-Strategy-Funktion konzipiert ist, damit UI/Datenmodell des v0.1-Builds sie ohne Umbau aufnehmen können. Referenz-Inspiration: kitandcarb.lovable.app (Kleidung + Fueling nach Wetter/Dauer).
---

## Warum jetzt nur Design, kein Build

Das MVP-Scope (Section 42 im Hauptdokument) schließt Fueling explizit aus, um zuerst die Kernkette GPX → Surface → Pressure zu validieren (siehe Section 29, gleiche Logik wie beim Weather-Ausschluss). Damit der spätere Ausbau aber keinen Rebuild des UI-Flows braucht, ist Fueling bereits als 5. Schritt im Klick-Prototyp mitgezeichnet und als "Vorschau · kommt in v0.2" gekennzeichnet.

## Eingaben für die Fueling-Berechnung

- **Fahrzeit (abgeleitet):** aus Routen-Distanz (bereits aus GPX vorhanden) und einer Intensitäts-abhängigen Durchschnittsgeschwindigkeit geschätzt. Keine zusätzliche Nutzereingabe nötig.
- **Rider Weight:** wiederverwendet aus dem Bike-Setup-Schritt (kein Doppel-Input).
- **Intensität:** neue Nutzereingabe, 3 Stufen (Locker / Ausdauer / Renntempo), beeinflusst sowohl die Geschwindigkeits- als auch die Kohlenhydrat-/Flüssigkeitsrichtwerte.
- **Wetter (nur für Flüssigkeitsbedarf):** Temperatur am Startpunkt/-zeitpunkt der Route, automatisch abgerufen. Das ist eine kleinere, eigenständige Wetter-Nutzung als das im Hauptdokument beschriebene "Weather-Aware Surface Conditions"-Feature (Section 26–29, das Regen/Untergrund-Zustand betrifft) – für Fueling reicht Lufttemperatur, keine Niederschlagshistorie. Beide Features können unabhängig voneinander eingeführt werden.
- **Terrain-Mix (bewusst noch NICHT berücksichtigt):** Gravel verbrennt mehr Kalorien als Asphalt bei gleicher Distanz. Das ist als Verbesserung für eine spätere Version vorgesehen (siehe Future Backlog), aber für v0.2 explizit ausgeklammert, um die erste Fueling-Version einfach zu halten.

## Ausgabe

- Kohlenhydrate: g/Stunde (Richtwert nach Intensität) + Gesamtmenge für die Route.
- Flüssigkeit: ml/Stunde (Richtwert nach Intensität, angepasst an Temperatur) + Gesamtmenge für die Route.
- Kommunikation als Richtwert/Startpunkt, gleiche Transparenz-Haltung wie beim Pressure-Ergebnis (Section 36 im Hauptdokument) – keine falsche Präzision.

## Platzierung im UX-Flow

Erweitert die UX-Architektur (Section 37) um einen 5. Schritt nach der Pressure-Empfehlung:

```
01 Route → 02 Surface → 03 Setup → 04 Pressure → 05 Fueling (v0.2)
```

Im Klick-Prototyp bereits als eigener Schritt umgesetzt (Intensitäts-Auswahl funktional, Kohlenhydrat-/Flüssigkeits-Werte reagieren live auf die Auswahl).

## Offene Punkte für den v0.2-Build

- Konkrete g/Stunde- und ml/Stunde-Richtwerte je Intensitätsstufe müssen vor dem Build recherchiert/kalibriert werden (aktuell nur Platzhalter-Beispielwerte im Design).
- Wetter-Datenquelle für Temperatur am Startpunkt muss ausgewählt werden (kleinere Anforderung als eine volle Niederschlags-API für das Surface-Feature).
- Wie granular sollen Intensitätsstufen sein (3 Stufen wie im Design, oder feiner)?
