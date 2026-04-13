function applyRule4NoImage(record) {
  const nextRecord = { ...record };
  const reasons = [];
  const imageCount = nextRecord.image_count;
  const hasOriginLink = Boolean(nextRecord.origin_link || nextRecord.image_driver);

  if ((nextRecord.log_matches?.driver_error || []).length > 0) {
    reasons.push("DRIVER_ERROR_LOGGED");
  }

  if (imageCount === 0) {
    reasons.push("IMAGE_COUNT_ZERO");
  }

  if (imageCount === null && nextRecord.api_errors?.count_image) {
    reasons.push("IMAGE_COUNT_UNAVAILABLE");
  }

  if (reasons.length === 0 && imageCount === null) {
    nextRecord.rule_4_status = "SKIP";
    nextRecord.rule_4_reason = hasOriginLink
      ? ["IMAGE_COUNT_NOT_CHECKED"]
      : ["IMAGE_SOURCE_MISSING"];
    return nextRecord;
  }

  nextRecord.rule_4_status = reasons.length > 0 ? "FAIL" : "PASS";
  nextRecord.rule_4_reason = reasons;
  return nextRecord;
}

module.exports = {
  applyRule4NoImage,
};
