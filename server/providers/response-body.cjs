const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Read a fetch response without allowing an unbounded body to enter memory. */
async function readResponseBytes(response, maximumBytes = DEFAULT_MAX_RESPONSE_BYTES, sizeError = "Response") {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("A positive response limit is required.");
  }
  const overflowError = sizeError instanceof Error ? sizeError : new Error(`${sizeError} is too large.`);
  if (Number(response.headers.get("content-length")) > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    throw overflowError;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw overflowError;
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readResponseJSON(response, maximumBytes = DEFAULT_MAX_RESPONSE_BYTES, label = "Response") {
  const bytes = await readResponseBytes(response, maximumBytes, label);
  if (!bytes.length) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function readResponseText(response, maximumBytes = DEFAULT_MAX_RESPONSE_BYTES, label = "Response") {
  return (await readResponseBytes(response, maximumBytes, label)).toString("utf8");
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
  readResponseBytes,
  readResponseJSON,
  readResponseText,
};
