## 0.1.2

- card-mod styling now applies to the card. card-mod adds its styling inside the card as the
  dashboard loads, and the card's first draw was wiping it.

## 0.1.1

- The card keeps one frame for its whole life and only redraws what's inside it, so styling attached
  to the card by a theme or card-mod no longer flickers when a count changes.

## 0.1.0

First release.

- **A flock per config entry**, with an optional hen count for the lay rate.
- **The card**, in three layouts. Full: minus and plus buttons, type an exact total, step back
  through past days or tap a bar, a note per day, a 7 to 60 day chart, totals for the week, month,
  year and all time, and a CSV export. Grid: an egg for each day over 2 to 12 weeks, each carrying
  its count. Compact: just today's count and the buttons.
- **Sensors** for today, yesterday, the last 7 days, this month, the running total, the 7-day
  average, the lay rate and the last day logged.
- **A number and two buttons** for today's count, and the `egg_track.add_eggs` and
  `egg_track.set_eggs` actions.
- Open cards update when the log changes anywhere, and catch up after the app has been in the
  background or the connection dropped.
- A day counts as logged once it has a count, even zero. A note on its own doesn't log it.
- Needs Home Assistant 2025.2 or newer.
