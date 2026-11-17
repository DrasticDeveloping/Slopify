# Proof for PR #66: snooze until a picked date

Recordings of PR #66 (branch `t3-for/custom-snooze-calendar`) running in the real app: the Vite dev server with isolated data and headless Edge at 1280×800 for desktop and 390×844 for phone, recorded on 17 Nov 2026. The library holds eight demo songs added for the recording. Nobody was signed in.

- `desktop.mp4` / `desktop.gif`:
  - Right-click → Snooze shows each length with when it ends.
  - Pick a date… opens the calendar; you pick a day and a time, then Snooze until. The toast with Undo and the SNOOZED badge appear.
  - Keyboard: arrows move between days, Enter picks, Esc goes back to the lengths.
  - Settings → Playback lists the snooze with its end time.
- `phone.mp4` / `phone.gif`: the same on a phone, as bottom sheets: ⋯ → Snooze → Pick a date… → calendar → Snooze.
- `*.png`: still frames of each step.

The white cursor and the captions were drawn into the page for the recording and aren't part of the app.

This branch only holds media. It isn't meant to be merged.
