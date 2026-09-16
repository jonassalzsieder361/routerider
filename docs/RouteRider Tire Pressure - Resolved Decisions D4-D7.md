---
Ergänzung zu: RouteRider Tire Pressure – Living Product & Build Document (v0.4 Draft)
Status: Resolved am 2026-09-16, vor Build-Start
Zweck: Löst die vier "Critical Open Decisions" (Section 47) des Hauptdokuments auf, damit Claude Code beim Bauen nicht laut der eigenen "Development Rule" (Section 45) stoppen muss.
---

## D4 — Tubeless Logic → RESOLVED

**Entscheidung:** Tubeless verändert die berechnete Pressure-Empfehlung NICHT direkt. Stattdessen erweitert Tubeless ausschließlich die sichere Untergrenze (Safety Bound) nach unten im Vergleich zu Tube.

**Begründung:** Physikalisch am unstrittigsten Effekt von Tubeless (kein Snake-Bite-Risiko, dadurch niedrigerer sicherer Minimaldruck möglich). Ohne eigene Kalibrierungsdaten wäre ein direkter Pressure-Modifier willkürlich. Kombiniert sauber mit D6.

**Implementierung v0.1:**
- Base Pressure Formel (Berto) bleibt unverändert von Tube/Tubeless.
- Tube/Tubeless-Wert fließt ausschließlich in die Safety-Bounds-Logik (siehe D6) ein: Tubeless erlaubt niedrigeren Min-PSI-Wert als Tube bei gleicher Reifenbreite.
- Spätere Verfeinerung (z.B. leichter direkter Modifier nach Kalibrierung) bleibt offen und ist kein Breaking Change.

## D5 — Map Matching Architecture → RESOLVED (v0.1)

**Entscheidung:** Eigene vereinfachte Matching-Heuristik statt externem Map-Matching-Service (z.B. Valhalla) für v0.1.

**Begründung:** Passt zur "kein Server/keine Datenbank"-MVP-Philosophie (Section 40/41), keine zusätzliche Infrastruktur/Kosten/Latenz. Architektur muss laut Hauptdokument ohnehin austauschbar bleiben (Section 8) — externer Service kann später nachgerüstet werden, falls Genauigkeit unzureichend ist.

**Implementierung v0.1 — Heuristik-Bausteine:**
1. Buffer-Suche: für jeden GPX-Punkt (oder Segment) alle OSM Ways innerhalb eines Radius (Startwert: 15–25 m) via Overpass abfragen.
2. Kandidaten-Bewertung anhand von: Distanz zum Way, Richtungsübereinstimmung (Bearing-Vergleich Route vs. Way), Geometrie-Overlap über mehrere aufeinanderfolgende Punkte (nicht Einzelpunkt-Matching).
3. Kontinuitäts-Check: bevorzugt Ways, die an das zuvor gematchte Way angrenzen/logisch anschließen, um Sprünge zwischen parallelen Wegen zu vermeiden.
4. Bei mehreren ähnlich guten Kandidaten ohne klaren Gewinner → Segment als "Ambiguous" markieren (fließt später in Confidence ein, siehe Section 13 "Future Confidence Model").
5. Matching-Modul wird als austauschbare Komponente implementiert (klar getrennte Schnittstelle), damit ein Ersatz durch Valhalla o.ä. später ohne Rewrite der Pressure-Engine möglich ist.

**Offen für später:** Falls reale Testrouten (Phase 3 "STOP → Test with multiple real GPX routes") signifikante Fehlzuordnungen zeigen, wird an dieser Stelle erneut evaluiert, ob ein externer Service nötig wird.

## D6 — Safety Pressure Bounds → RESOLVED (v0.1)

**Entscheidung:** Generische, konservative Min/Max-PSI-Tabelle nach Reifenbreite + Tube/Tubeless als Standard-Fallback. Optional kann der Nutzer den auf der Reifenflanke aufgedruckten Min/Max-Wert eingeben — dieser hat dann Vorrang vor der generischen Tabelle.

**Begründung:** Löst die in Section 24 beschriebene Anforderung ("darf eine berechnete Empfehlung nicht automatisch als sicher darstellen"), ohne den MVP von einer vollständigen Hersteller-Datenbank (Reifen × Felge × Modell) abhängig zu machen. Nutzer-Input als Override deckt die genauesten Fälle ab, generische Tabelle deckt den Rest sicher genug ab.

**Implementierung v0.1:**
- Interne Lookup-Tabelle: grobe Reifenbreiten-Buckets (z.B. <32mm, 32–40mm, 40–50mm, >50mm) je mit Min/Max-PSI für Tube und Tubeless getrennt (Tubeless-Min niedriger, siehe D4).
- Berechnete Empfehlung wird gegen diese Bounds geklemmt (clamp); wenn Clamping angewendet wurde, wird das dem Nutzer sichtbar mitgeteilt ("Wir haben deinen Wert auf den sicheren Bereich angepasst").
- Optionales Eingabefeld "Min/Max PSI laut Reifenaufdruck (optional)" — wenn ausgefüllt, ersetzt es die generische Tabelle für diesen Nutzer/diese Berechnung.
- Disclaimer bleibt in jedem Fall sichtbar (Section 36 Produkttransparenz).
- Konkrete Zahlenwerte für die Lookup-Tabelle müssen vor Phase 7 (Pressure Engine) recherchiert/festgelegt werden — das ist ein separater Recherche-Schritt, keine offene Produktentscheidung mehr.

## D7 — Surface Inference Rules → RESOLVED (v0.1)

**Entscheidung:** Einfache Regeltabelle ergänzt fehlendes `surface=*` anhand von `tracktype` und `highway`, wie in Section 12 als Prinzip bereits vorgesehen.

**Regeltabelle v0.1** (alle als "Inferred", nicht "Direct" markiert — Unterscheidung wird intern gespeichert für spätere Confidence-Verfeinerung laut Section 13):

| Bedingung | Inferred Surface Class |
|---|---|
| `tracktype=grade1` oder `grade2` (kein surface) | Gravel |
| `tracktype=grade3`, `grade4` oder `grade5` (kein surface) | Trail |
| `highway=path`, `bridleway` oder `footway` (kein surface, kein tracktype) | Trail |
| `highway=cycleway` (kein surface) | Paved |
| `highway=residential`, `tertiary`, `secondary`, `primary`, `unclassified` (kein surface) | Paved |
| `highway=track` (kein surface, kein tracktype) | Gravel (niedrige Konfidenz) |
| Keine der obigen Bedingungen erfüllt | Unknown |

**Hinweis:** Diese Regeln sind bewusst grob gehalten (v0.1-Kalibrierungsparameter, keine fixen Wahrheiten) und für Deutschland/Mitteleuropa plausibel; regionale Abweichungen (z.B. unbefestigte "residential" Straßen in manchen Ländern) sind ein bekannter Future-Punkt, kein v0.1-Blocker.

---

## Auswirkung auf Section 47 (Critical Open Decisions) im Hauptdokument

Alle vier Punkte (D4–D7) gelten ab sofort als **Decided (v0.1)** und sollten in einer nächsten Überarbeitung des Hauptdokuments (v0.5) aus "Critical Open Decisions" in "Resolved Decisions" (Section 46) verschoben werden. Der MVP-Build (Phase 0 ff.) kann auf Basis dieser Entscheidungen gestartet werden, ohne dass Claude Code laut Development Rule (Section 45) stoppen muss.
