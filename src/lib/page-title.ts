import type { AppState, Route } from "../state/store";

/** Also used by the inert bar underneath a phone's back swipe. */
export function pageTitle(route: Route, state: AppState) {
  switch (route.name) {
    case "artist": case "discography": case "popular": return state.artists[route.id]?.name || "Artist";
    case "album": return state.albums[route.id]?.title || "Album";
    case "playlist": return state.playlists.find((p) => p.id === route.id)?.name || "Playlist";
    case "song": return route.title;
    default: return ({ home: "Home", search: "Search", library: "Your Library", playlists: "Playlists", storage: "Storage", server: "Music server", history: "History", friends: "Friends", shared: "Shared playlist", release: "Release", mix: "Mix" } as Record<string, string>)[route.name] || "Slopify";
  }
}
