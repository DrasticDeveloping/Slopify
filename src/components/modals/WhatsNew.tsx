import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDayChange } from "../../lib/hooks";
import { buildLabel, builtAt, isNightly, plural, shortStamp } from "../../lib/releases";
import { closeModal } from "../../state/actions";
import { installUpdate, useDesktopUpdates } from "../../state/desktop";
import { Icon } from "../Icon";
import { Shell } from "./Shell";

/** Builds shown before the rest fold away. */
const SHOWN = 3;

/** Every change between the installed version and the waiting update, newest build first. */
export function WhatsNewModal() {
  const u = useDesktopUpdates();
  const log = u?.available ? u.changelog : null;
  const [all, setAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useDayChange();

  // The update went away (another channel chosen, say): nothing to show.
  useEffect(() => {
    if (!log) closeModal();
  }, [log]);

  // The list fades at the bottom while more is below, so a cut-off list doesn't look finished.
  useLayoutEffect(() => {
    const body = list.current?.parentElement;
    if (!body) return;
    const update = () => body.classList.toggle("more-below", body.scrollTop + body.clientHeight < body.scrollHeight - 2);
    update();
    body.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(body);
    return () => {
      body.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [all, log]);

  if (!u?.available || !log) return null;
  const installed = builtAt(u.version);
  const builds = all ? log.builds : log.builds.slice(0, SHOWN);
  const folded = log.builds.slice(SHOWN);
  const foldedChanges = folded.reduce((sum, b) => sum + b.changes.length + b.more, 0);
  const changes = plural(log.total, "change");
  const summary = log.builds.length === 1
    ? `${changes} since yours`
    : log.complete ? `${changes} in ${log.builds.length} builds since yours` : `${changes} in the ${log.builds.length} newest builds`;

  return (
    <Shell
      title="What’s new"
      className="whats-new"
      eyebrow={<>{u.status === "available" ? "Update available" : "Update ready"}{isNightly(u.available) ? <span className="ub-chip">Nightly</span> : null}</>}
      art={<span className="ub-badge"><Icon name="sparkleFill" size={21} /></span>}
      subtitle={
        <>
          {summary}{installed && isNightly(u.version) ? <> ({shortStamp(installed).replace(/ /g, " ")})</> : null}.
          <span className="wn-version" title={u.available}>Installs {u.available}</span>
        </>
      }
      footer={
        <>
          <a className="wn-link" href={log.url} target="_blank" rel="noreferrer">
            <Icon name="external" size={14} />Full changelog on GitHub
          </a>
          <button type="button" className="btn" onClick={closeModal}>Later</button>
          <button type="button" className="btn primary" onClick={() => { installUpdate(); if (u.portable) closeModal(); }}>
            {u.portable ? <>Open download page <Icon name="external" size={15} /></> : <><Icon name="sync" size={16} />Restart to update</>}
          </button>
        </>
      }
    >
      <div ref={list} className="wn-list">
        {builds.map((build, i) => {
          const date = builtAt(build.version, build.date);
          return (
            <section key={build.version} className="wn-build" aria-label={date ? buildLabel(date) : build.version}>
              <h3 className="wn-build-head">
                <span>{date ? buildLabel(date) : build.version}</span>
                {build.nightly ? null : <span className="ub-chip">Slopify {build.version}</span>}
                {i === 0 ? <span className="ub-chip new">Newest</span> : null}
              </h3>
              <ul className={`wn-changes${i === 0 ? " newest" : ""}`}>
                {build.changes.map((change, j) => (
                  <li key={j}>
                    <span>{change.text}</span>
                    {change.pr ? <a href={`${log.repoUrl}/pull/${change.pr}`} target="_blank" rel="noreferrer" aria-label={`Pull request ${change.pr}`}>#{change.pr}</a> : null}
                  </li>
                ))}
                {/* Every change in it was reverted. */}
                {!build.changes.length && !build.more ? <li className="wn-none"><span>Nothing new to list</span></li> : null}
                {build.more ? (
                  <li className="wn-more">
                    <a href={log.url} target="_blank" rel="noreferrer">…and {plural(build.more, "more change")} on GitHub</a>
                  </li>
                ) : null}
              </ul>
            </section>
          );
        })}
        {folded.length ? (
          <button type="button" className="wn-older" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Hide older builds" : <>{plural(folded.length, "older build")} · {plural(foldedChanges, "change")}</>}
            <Icon name={all ? "chevronUp" : "chevronDown"} size={15} />
          </button>
        ) : null}
      </div>
    </Shell>
  );
}
