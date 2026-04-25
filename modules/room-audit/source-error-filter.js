function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return value.toString().trim();
}

const TRANSIENT_SOURCE_ERROR_PATTERNS = [
  /quota exceeded/i,
  /read requests per minute/i,
  /user rate limit exceeded/i,
  /rate limit/i,
  /\b429\b/i,
  /timed?\s*out/i,
  /deadline exceeded/i,
  /econnreset/i,
  /etimedout/i,
  /socket hang up/i,
];

function isTransientSourceErrorMessage(message = "") {
  const text = normalizeText(message);
  if (!text) {
    return false;
  }

  return TRANSIENT_SOURCE_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function isCode3SourceError(sourceError = {}) {
  const step = normalizeText(sourceError?.step).toLowerCase();
  if (step && step !== "processcsvdata") {
    return false;
  }

  return !isTransientSourceErrorMessage(sourceError?.message || "");
}

function filterCode3SourceErrors(sourceErrors = []) {
  if (!Array.isArray(sourceErrors)) {
    return [];
  }

  return sourceErrors.filter((sourceError) => isCode3SourceError(sourceError));
}

module.exports = {
  filterCode3SourceErrors,
  isCode3SourceError,
  isTransientSourceErrorMessage,
};

