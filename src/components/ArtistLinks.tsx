import { Fragment } from "react";
import type { Track } from "../data/types";
import { navigate } from "../state/actions";
import { useStore, type AppState, type Route } from "../state/store";

/** Each artist credited on a track, as a link to their page. */
type ArtistLinksProps = { track: Pick<Track, "artistId" | "featuring">; className?: string; go?: (route: Route) => void; inRow?: boolean; artists?: AppState["artists"] };
export function ArtistLinks(props: ArtistLinksProps) {
  return props.artists ? <ArtistNames {...props} artists={props.artists} /> : <SubscribedArtists {...props} />;
}
function SubscribedArtists(props: ArtistLinksProps) {
  const artists = useStore((s) => s.artists);
  return <ArtistNames {...props} artists={artists} />;
}
function ArtistNames({ track, className = "link", go = navigate, inRow = false, artists }: ArtistLinksProps & { artists: AppState["artists"] }) {
  const ids = [track.artistId, ...(track.featuring ?? [])].filter((id) => artists[id]);
  return (
    <>
      {ids.map((id, i) => (
        <Fragment key={id}>
          {i ? ", " : null}
          <button
            type="button"
            className={className}
            tabIndex={inRow ? -1 : undefined}
            onClick={(e) => {
              // In a track row, a click on the artist doesn't also select or play the row.
              if (inRow) e.stopPropagation();
              go({ name: "artist", id });
            }}
          >
            {artists[id].name}
          </button>
        </Fragment>
      ))}
    </>
  );
}
