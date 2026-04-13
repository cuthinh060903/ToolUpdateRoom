function parseDateValue(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function applyRule1Update(record, options = {}) {
  const nextRecord = { ...record };
  const reasons = [];
  const thresholdHours = Number.isFinite(options?.thresholdHours)
    ? options.thresholdHours
    : 24;
  const updatedAtSource =
    nextRecord.room_updated_at || nextRecord.building_updated_at
      ? nextRecord.room_updated_at
        ? "rooms.updated_at"
        : "realnews.updated_at"
      : null;
  const updatedAtValue =
    nextRecord.room_updated_at ||
    nextRecord.building_updated_at ||
    nextRecord.last_updated_at;

  nextRecord.last_updated_at = updatedAtValue || null;
  nextRecord.last_updated_source =
    updatedAtSource || nextRecord.last_updated_source || null;

  if (!nextRecord.last_updated_at) {
    nextRecord.rule_1_status = "SKIP";
    nextRecord.rule_1_reason = ["UPDATED_AT_MISSING"];
    return nextRecord;
  }

  const parsedDate = parseDateValue(nextRecord.last_updated_at);
  if (!parsedDate) {
    nextRecord.rule_1_status = "FAIL";
    nextRecord.rule_1_reason = ["UPDATED_AT_INVALID"];
    return nextRecord;
  }

  const ageMs = Date.now() - parsedDate.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  nextRecord.rule_1_age_hours = Number(ageHours.toFixed(2));

  if (ageHours > thresholdHours) {
    reasons.push(`STALE_GT_${thresholdHours}H`);
  }
  nextRecord.rule_1_status = reasons.length > 0 ? "FAIL" : "PASS";
  nextRecord.rule_1_reason = reasons;
  return nextRecord;
}

module.exports = {
  applyRule1Update,
};
