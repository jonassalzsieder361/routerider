@AGENTS.md

# RouteRider

RouteRider berechnet Reifendruck-Empfehlungen für Radfahrer auf Basis
einer hochgeladenen Route. Kernablauf:

GPX Upload → Map Matching gegen OSM → Surface-Mix → Bike-Setup →
Pressure Engine (Berto-Formel) → Front/Rear-Empfehlung

## Produktdefinition & Kernentscheidungen

- **Haupt-Produktdefinition:** [docs/RouteRider Tire Pressure.md](docs/RouteRider%20Tire%20Pressure.md)
- **Bereits aufgelöste Kernentscheidungen (D4–D7):** [docs/RouteRider Tire Pressure - Resolved Decisions D4-D7.md](docs/RouteRider%20Tire%20Pressure%20-%20Resolved%20Decisions%20D4-D7.md)

Beide Dateien sind aktuell Platzhalter und werden noch befüllt.

## Wichtig: Nicht eigenständig entscheiden

Bei Unsicherheit zu einem der folgenden Themen **nicht selbst entscheiden**,
sondern beim Nutzer nachfragen:

- Produktlogik
- Pressure-Berechnung (Berto-Formel und Ableitungen)
- Surface-Klassifizierung
- Map-Matching-Architektur
- UX
