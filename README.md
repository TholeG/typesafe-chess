# Jev gegen Jev – Schach mit TypeSafe System One

Zwei virtuelle Spieler, beide entscheiden mit dem TypeSafe-Modell **Jev**.
Die Regeln kennt `chess.js`; Jev bekommt pro Zug die Stellung und alle legalen
Züge als Choice-Optionen (mit vom Regelwerk berechneten Fakten wie Schlag,
Schach, hängende Figur) und wählt einen aus. Im selben Aufruf liefert Jev eine
Stellungsbewertung (Score) und eine Einschätzung der taktischen Schärfe (Noul),
die nur angezeigt werden.

## Start

```sh
npm install
# TYPESAFE_API_KEY muss im Environment stehen (siehe .env)
npm start
# http://localhost:3000
```

## Dateien

- `jev-player.js` – Aufbau von State und Fragen, Aufruf des SDK, Zugauswahl
- `server.js` – Express-API (`/api/state`, `/api/new`, `/api/step`), Key bleibt serverseitig
- `public/index.html` – Brett, Autoplay, Kandidatenwahrscheinlichkeiten, Bewertung

## Spielstile

`PLAYERS` in `jev-player.js` gibt Weiß einen aktiven und Schwarz einen soliden
Stil mit. Der Stil steht im State und in den Instructions; die Fakten zu jedem
Zug kommen aus dem Code.
