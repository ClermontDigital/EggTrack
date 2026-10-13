# Egg Track - a daily egg log for Home Assistant

Count the eggs your chickens lay each day. Log them from a dashboard card, a button, an NFC tag in
the coop or a voice command, and see how the flock is laying over the week, the month and the year.
Everything is stored in your own Home Assistant.

<img src="https://raw.githubusercontent.com/ClermontDigital/EggTrack/main/images/widget.png" alt="The compact layout on a dashboard, under an Eggs heading: a strip with a minus button, 5 eggs today, an egg-shaped plus button, a 7-day average of 5 and a calendar button" width="465">

<img src="https://raw.githubusercontent.com/ClermontDigital/EggTrack/main/images/widget-popup.png" alt="The popup the calendar button opens: today's count with its buttons above a tray of eggs, a week to a row, with today's egg carrying a 5" width="330">

These two are from a real dashboard on its first day, styled with card-mod. The screenshots further
down use made-up data.

## Features

- **One tap to log an egg.** Big minus and plus buttons, or tap the number to type the day's total.
- **An egg for each day.** The grid layout lays the last few weeks out like a tray of eggs, each one
  carrying its day's count and shaded from pale on a light day to golden on your best.
- **A small widget when that's all you want.** The compact layout is one strip with today's count
  and the 7-day average, and it opens the grid of days in a popup.
- **Fix or fill in past days.** Step back a day at a time, or tap any egg or bar.
- **How the flock is laying.** Last 7 days, this month, this year and all time, a 7-day average, the
  lay rate for your number of hens, days in a row with eggs, and your best day.
- **"No eggs" is not the same as "not logged".** The average doesn't dip each morning before the
  eggs are collected: today only counts once you've logged it, even if that's to say there were none.
- **Notes.** A line per day for a broody hen, a moult or a cracked egg.
- **Sensors, buttons and actions**, so automations can log eggs and dashboards can graph them.
  The running total feeds Home Assistant's long-term statistics.
- **More than one flock.** Keep hens and ducks apart.
- **Stays in step.** Log on one phone and every open card updates.
- **Your data.** Stored in Home Assistant, with a CSV export on the card.
- **Follows your theme**, light or dark.

## Installation

### Requirements

Home Assistant 2025.2 or newer.

### HACS

1. In HACS, open the menu (top right) and choose **Custom repositories**.
2. Add `https://github.com/ClermontDigital/EggTrack` with the type **Integration**.
3. Find **Egg Track** in HACS, download it, and restart Home Assistant.

### Manual

Copy `custom_components/egg_track` into your Home Assistant `config/custom_components` folder and
restart.

### Adding a flock

Go to **Settings > Devices & services > Add integration** and choose **Egg Track**. Give the flock a
name and, if you'd like a lay rate, the number of laying hens. Add the integration again for a
second flock. The hen count can be changed later under the flock's **Configure** button.

### The card

The card is installed with the integration. Edit a dashboard, choose **Add card** and search for
**Egg Track**, or add it in YAML:

```yaml
type: custom:egg-track-card
```

| Option | Default | What it does |
|---|---|---|
| `entry_id` | your first flock | Which flock to show. Pick it from the list in the card editor. |
| `view` | `full` | `full` has a bar chart, totals, a note and the export. `grid` has an egg for each day. `compact` is a strip with today's count, the 7-day average and a button that opens the grid in a popup. |
| `weeks` | `5` | Weeks in the grid and in the compact layout's popup, from 2 to 12. |
| `days` | `14` | Days in the bar chart, from 7 to 60. |
| `title` | the flock's name | A different heading. |
| `hide_title` | `false` | Leave the heading out, for when the card sits under a heading of its own. |

<p>
  <img src="https://raw.githubusercontent.com/ClermontDigital/EggTrack/main/images/grid.png" alt="The grid layout after a few weeks: today's count with a minus button and an egg-shaped plus button, above five weeks of eggs, each carrying that day's count" width="300">
  <img src="https://raw.githubusercontent.com/ClermontDigital/EggTrack/main/images/card.png" alt="The full layout: today's count, averages, a 14-day bar chart, totals and a note" width="300">
  <img src="https://raw.githubusercontent.com/ClermontDigital/EggTrack/main/images/card-light.png" alt="The full layout in a light theme" width="300">
</p>

In the grid, a week runs along each row from Monday, with this week at the bottom. A day logged as
zero is an empty shell with a 0 in it, and a day nobody logged is a dotted hollow. Tap an egg to see
or change that day.

Tap the number to type an exact total. On a day nobody has logged, **No eggs today** records a zero.
A note on its own doesn't log the day. **Clear this day** forgets a day's count and note. The colours can be changed in a theme:
`egg-track-accent` for the buttons, and `egg-track-shell-pale` and `egg-track-shell-rich` for the
eggs on a light day and on your best day.

The compact layout's popup takes its background and border from the card, so a card styled with a
theme or card-mod gets a matching popup.

If the card doesn't appear after installing, refresh the browser. On a dashboard managed in YAML,
add `/egg_track/egg-track-card.js` as a JavaScript module resource.

## Entities

Each flock is a device with these entities. `chickens` below is the flock's name.

| Entity | What it is |
|---|---|
| `sensor.chickens_eggs_today` | Today's count |
| `sensor.chickens_eggs_yesterday` | Yesterday's count |
| `sensor.chickens_eggs_last_7_days` | Today and the six days before |
| `sensor.chickens_eggs_this_month` | This calendar month so far |
| `sensor.chickens_eggs_total` | Every egg logged. Use this one for statistics graphs. |
| `sensor.chickens_daily_average` | Eggs a day over the last 7 days |
| `sensor.chickens_lay_rate` | The daily average as a percentage of your hens. Unknown until a hen count is set. |
| `sensor.chickens_last_logged` | The date of the latest day logged |
| `number.chickens_eggs_today` | Today's count as a number you can set |
| `button.chickens_add_egg` | Adds one egg to today |
| `button.chickens_remove_egg` | Takes one egg off today |

To chart eggs per day or per week without the card, use a statistics graph on the total:

```yaml
type: statistics-graph
entities:
  - sensor.chickens_eggs_total
stat_types:
  - change
period: day
days_to_show: 30
chart_type: bar
```

That graph counts eggs on the day they were typed in, not the day they were laid: yesterday's eggs
filled in this morning show up under today. The card always puts them on the right day.

## Actions

`egg_track.add_eggs` adds to a day's count. `count` defaults to 1 and can be negative; the count
never goes below zero, and taking eggs away from a day nobody has logged does nothing. `date` defaults
to today.

```yaml
action: egg_track.add_eggs
data:
  count: 3
```

`egg_track.set_eggs` sets a day's count to an exact number, with an optional note.

```yaml
action: egg_track.set_eggs
data:
  eggs: 5
  date: "2026-10-12"
  note: Two from the nest under the lemon tree
```

Both take an optional `entry_id` to choose the flock. It's only needed when you have more than one.

## Automation ideas

An NFC tag on the coop door that logs an egg each time it's scanned:

```yaml
triggers:
  - trigger: tag
    tag_id: your-tag-id
actions:
  - action: button.press
    target:
      entity_id: button.chickens_add_egg
```

A reminder at 6 pm if nobody has logged today:

```yaml
triggers:
  - trigger: time
    at: "18:00:00"
conditions:
  - condition: template
    value_template: "{{ states('sensor.chickens_last_logged') != now().date().isoformat() }}"
actions:
  - action: notify.mobile_app_your_phone
    data:
      message: Have the eggs been collected today?
```

Logging by voice ("I collected four eggs"). Speech-to-text may hear the number as a word or as
digits, so this takes either, up to twelve as a word:

```yaml
triggers:
  - trigger: conversation
    command:
      - "I collected {count} eggs"
      - "add {count} eggs"
variables:
  words: {a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12}
  said: "{{ trigger.slots.count | trim | lower }}"
  count: "{{ words.get(said, said | int(0)) }}"
conditions:
  - condition: template
    value_template: "{{ count > 0 }}"
actions:
  - action: egg_track.add_eggs
    data:
      count: "{{ count }}"
```

## How the numbers work

- A day is **logged** once it has a count, even a count of zero. A day with no count is not, whether
  or not it has a note: it adds nothing to a total, and it shows as a dashed gap in the chart.
- The **7-day average** covers the seven days ending today once today is logged, and ending
  yesterday until then, so the average doesn't dip every morning before the eggs are collected.
  Earlier days nobody logged inside that week count as zero. It never reaches back before your
  first logged day.
- The **lay rate** is the 7-day average divided by your number of hens.
- **Days in a row** counts back from the same day as the average and stops at the first day without
  eggs.
- Weeks run Monday to Sunday.

## Your data

Each flock's log is a small file in Home Assistant's `.storage` folder (`egg_track.<id>`), so it's
included in your Home Assistant backups. Nothing is sent anywhere. **Export CSV** on the card
downloads every day with a count or a note. Deleting a flock from **Devices & services** deletes
its log.

Anyone signed in to your Home Assistant can view and log eggs.

## WebSocket API

The card talks to the integration over Home Assistant's WebSocket connection. `entry_id` is the
flock's config entry id; dates are `YYYY-MM-DD`.

| Command | Fields | Returns |
|---|---|---|
| `egg_track/flocks` | | Each flock's `entry_id`, `name` and `hens` |
| `egg_track/overview` | `entry_id`, `date` (optional), `days` (optional, 14) | The flock, today's date, the chosen day, the statistics, and the daily, weekly and monthly series |
| `egg_track/days` | `entry_id`, `start`, `end` (both optional) | Days with a count or a note: `eggs` (null when there's only a note) and `note` |
| `egg_track/add` | `entry_id`, `count` (optional, 1), `date` (optional) | The day's record |
| `egg_track/set_day` | `entry_id`, `eggs` and/or `note`, `date` (optional) | The day's record |
| `egg_track/clear_day` | `entry_id`, `date` | The day's record, now not logged |
| `egg_track/subscribe` | `entry_id` | An event each time the flock's log changes |

## Development

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements_test.txt
pytest
```

`custom_components/egg_track/engine.py` holds the calculations and has no Home Assistant imports.
The card is one plain JavaScript file with no build step:
`custom_components/egg_track/www/egg-track-card.js`.

The card has its own checks, run in headless Chrome against the real storage rules with made-up
data. They also retake the screenshots in `images/`.

```bash
npm install --no-save puppeteer-core
node tests/card/drive.cjs
```

Set `CHROME` to your Chrome or Chromium if it isn't in the default macOS location. To look at the
card by hand, run `python tests/card/server.py` and open `http://127.0.0.1:8799/`.

## Issues and contributions

Bug reports and ideas are welcome in [Issues](https://github.com/ClermontDigital/EggTrack/issues).
Pull requests are welcome too; please include a test for anything in `engine.py` or the API.

## License

[Apache License 2.0](LICENSE)
