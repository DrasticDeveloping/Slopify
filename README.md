# Proof for PR #67

Media recorded from the real Slopify iOS app built from PR #67 (commit `57541db`), running in the iOS Simulator
(iPhone 17 Pro, iOS 26.5), driven by agent-device. Blue dots in the clips are the recorder's touch overlay.
This branch is an orphan and is never merged.

| File | Shows |
| --- | --- |
| `back-swipe.*` | Left-edge back swipe: a short drag reveals the page underneath and springs back; a full drag goes back |
| `sheet-drag.*` | Song options sheet (no Cancel button): partial drag springs back, a longer drag slides it away |
| `player-scroll-to-close.*` | Full player: scroll down, then one drag scrolls back to the top and closes the player |
| `player-play-and-fling.*` | Full player: play, scroll, flick down to close (slides away, doesn't vanish) |
| `*.png` | Stills: Home and tab bar, song statistics, options sheet, full player |
| `now-playing-log.txt` | System Now Playing log: next/previous enabled, 512x512 cover, cover follows the song |
