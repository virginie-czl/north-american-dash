repo: virginie-czl/north-american-dash
branch: main

## Last sync

date: 2026-07-25T00:06:53Z

### Updated in this project

- Recreated the current L'Oréal CA SLA Tracker screen (navy sidebar shell + KPI cards + detailed table).
- Added three table-first layout options: light sidebar, 64px icon rail, top-bar-only.
- Summary KPIs moved into a collapsible strip, collapsed by default; table is full-bleed.
- Chose the top-bar shell (1c) and built it out full-screen in Naboo Tracker v2 (three trackers as tabs).
- Restored the PO emission date ("since <date>") under the PO number, as in index.tsx.
- Row toggles now open the event drawer: partner breakdown, invoices, and comments thread.

## Screen map

| Screen | Repo files |
| --- | --- |
| Naboo Tracker — Current UI.dc.html | src/routes/_authenticated/route.tsx, src/routes/_authenticated/index.tsx, src/styles.css, src/routes/__root.tsx |
| Naboo Tracker — Table-first.dc.html | src/routes/_authenticated/route.tsx, src/routes/_authenticated/index.tsx, src/routes/_authenticated/tracking-north-america.tsx, src/styles.css |
| TrackerTable.dc.html | src/routes/_authenticated/index.tsx, src/styles.css (.na-table rules) |
| TrackerTableNA.dc.html | src/routes/_authenticated/tracking-north-america.tsx, src/styles.css (.na-table, .na-pill rules) |
| Naboo Tracker v2.dc.html | src/routes/_authenticated/route.tsx, src/routes/_authenticated/index.tsx, src/routes/_authenticated/veolia.tsx, src/routes/_authenticated/tracking-north-america.tsx |
