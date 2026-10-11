const path = require("node:path");

// Windows treats device names as reserved even when another extension follows
// (for example, CON.backup.mp3).
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i;
const WINDOWS_INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

function sanitizeWindowsFilename(value, options = {}) {
  const fallback = String(options.fallback || "");
  const maximumLength = Math.max(16, Math.min(240, Number(options.maximumLength) || 240));
  const cleanLeaf = (candidate) => {
    // Treat either separator as a path boundary when the caller provides a
    // path; metadata callers keep separators so they can be replaced below.
    const text = String(candidate || "");
    const leaf = options.pathInput === false ? text : text.split(/[\\/]/).at(-1) || "";
    return leaf
      .replace(WINDOWS_INVALID_FILENAME_CHARACTERS, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
  };
  let name = cleanLeaf(value);

  if (!name) name = cleanLeaf(fallback);
  if (!name) return "";

  let extension = path.extname(name).replace(/[. ]+$/g, "");
  let stem = path.basename(name, path.extname(name)).replace(/[. ]+$/g, "");
  if (!stem) stem = "Track";
  if (WINDOWS_RESERVED_STEM.test(stem)) stem = stem.replace(WINDOWS_RESERVED_STEM, "$&_");

  const availableStemLength = Math.max(1, maximumLength - extension.length);
  stem = stem.slice(0, availableStemLength).replace(/[. ]+$/g, "") || "Track";
  if (WINDOWS_RESERVED_STEM.test(stem)) stem = stem.replace(WINDOWS_RESERVED_STEM, "$&_").slice(0, availableStemLength);
  extension = extension.slice(0, Math.max(0, maximumLength - stem.length));
  return `${stem}${extension}`.replace(/[. ]+$/g, "");
}

function windowsCollisionFilename(value, counter, options = {}) {
  const maximumLength = Math.max(16, Math.min(240, Number(options.maximumLength) || 240));
  const safe = sanitizeWindowsFilename(value, { ...options, maximumLength });
  const extension = path.extname(safe);
  const suffix = ` ${Math.max(2, Math.floor(Number(counter) || 2))}`;
  const stem = path.basename(safe, extension);
  const available = Math.max(1, maximumLength - extension.length - suffix.length);
  return sanitizeWindowsFilename(`${stem.slice(0, available)}${suffix}${extension}`, {
    ...options,
    maximumLength,
    pathInput: false,
  });
}

module.exports = {
  WINDOWS_RESERVED_STEM,
  sanitizeWindowsFilename,
  windowsCollisionFilename,
};
