# Slopify privacy policy

Effective 21 October 2026. Slopify is made by DrasticDeveloping. Questions and requests go through [GitHub issues](https://github.com/DrasticDeveloping/Slopify/issues).

## The short version

Slopify keeps your music and listening on your own computer. If you sign in, a copy of your library (links and details, never audio) and your profile are kept with your account so they follow you to your other devices. Nothing is sold, and there are no ads or analytics.

## Without an account

Everything stays on your computer: songs, playlists, likes, listening history, recommendations and settings, in Slopify's library folder and the app's own storage. Nothing is sent to DrasticDeveloping.

To find and play music, Slopify's music server (which runs on your computer) contacts other services directly:

- **YouTube, SoundCloud and Spotify**, to search and to fetch the songs you choose.
- **A public Spotify search service** (`debridvault.elfhosted.com`), for Spotify search.
- **ListenBrainz, MusicBrainz and Cover Art Archive**, for recommendations and release details. Only artist names and song titles are sent, never your history.
- **TheAudioDB and Wikipedia**, for artist pictures and biographies. Only artist names are sent.
- **LRCLIB**, for lyrics, when you open them. Only the song's title, artist, album and length are sent.
- **Deezer**, for artist pictures and for the album a song is from. Artist names and song titles are sent, never your history.
- **GitHub**, when the desktop app checks for updates.
- **Discord**, if "Show what you're playing on Discord" is on in the desktop app, which shows the current song on your Discord profile.

Those services see your computer's network address, as with any website, and follow their own privacy policies.

## With a Slopify account

Signing in uses [Clerk](https://clerk.com), which keeps your email address, password (hashed) and sign-in sessions. Slopify's online service (on Cloudflare) keeps:

- **Your profile:** the display name, username and picture you chose.
- **Your library:** each song saved from a link (its link and details, such as title, artist, album, artwork link and clip), and one document of your playlists, likes, listening history, recommendation feedback and settings.
- **Friends:** your friend code, your friends, and friend requests you sent or received.
- **What you're playing**, if "Friends see what I'm playing" is on (Settings → Account; it's on by default): the current song's title, artist, link and artwork, whether it's paused, and the code of a Listen Along room you host. Only your friends see it, for 10 minutes after it last changed. Only the latest is kept, deleted when you turn the setting off and a day after it last changed.
- **Shared playlists:** a playlist you share is kept as its name, description and songs (links and details), with your display name and picture. Anyone signed in to Slopify with its link can see it, and your friends can see it on your profile if you leave that on. Which shared playlists people follow, and which friends sent them one, is kept too. Stopping sharing deletes it.
- **Listen Along rooms**, while they're open: who's in the room and what the host is playing. A room ends a minute after its host leaves, five minutes after everyone has, or a day after it started, and is then deleted. Which rooms your account started or joined is kept for up to three days (removed daily once it's two days old), so deleting your account can remove you from them.

Songs added from files on your computer, and the audio of any song, never leave your computer.

This data is used only to sync your library between your devices, to run Listen Along, and to show your friends and the playlists you share. Cloudflare and Clerk process it on Slopify's behalf. Cloudflare keeps database recovery points for a limited time (up to 30 days) after any change, including a deletion. To keep the service within its limits, it logs the kind of each call (such as "sync your library"), its result and how long it took, for a few days; these logs don't say who called, from where, or which songs, playlists or people it was about.

## Your choices

- **See your data:** everything synced is in the app (Library, Playlists, History, Settings).
- **Stop syncing:** sign out. Your library stays on your computer.
- **Stop sharing:** turn off "Friends see what I'm playing", stop sharing a playlist from its Share dialog, or remove friends on the Friends page.
- **Delete your account:** Settings → Account → Delete account. This deletes your profile, synced library, friends, friend requests and shared playlists from Slopify's service, removes you from Listen Along rooms (ending the ones you host), and deletes your sign-in from Clerk. For 15 minutes afterwards the service uses your account's ID only to refuse anything your other devices try to save to it, and removes it within a day after that. Your computer keeps its own songs and playlists.
- **Delete local data:** Settings → General → Reset app data clears playlists, settings and recommendations on this device; deleting Slopify's library folder removes its songs too.

## Children

Slopify isn't intended for children under 13, and accounts aren't knowingly created for them.

## Changes

Changes to this policy are published in this file, with a new effective date.
