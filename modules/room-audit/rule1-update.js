function parseDateValue(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (Array.isArray(value)) {
    const [year, month, day, hour = 0, minute = 0, second = 0] = value.map(
      (item) => Number(item),
    );

    if (
      ![year, month, day, hour, minute, second].every((item) =>
        Number.isFinite(item),
      )
    ) {
      return null;
    }

    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59 ||
      second < 0 ||
      second > 59
    ) {
      return null;
    }

    const parsed = new Date(year, month - 1, day, hour, minute, second);
    if (
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day ||
      parsed.getHours() !== hour ||
      parsed.getMinutes() !== minute ||
      parsed.getSeconds() !== second
    ) {
      return null;
    }

    return parsed;
  }

  const normalizedValue = value.toString().trim();
  if (!normalizedValue) {
    return null;
  }

  const isoLikeMatch = normalizedValue.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?(?:\s*(AM|PM))?$/i,
  );
  if (isoLikeMatch) {
    const [, year, month, day, rawHour, minute, second, meridiem] =
      isoLikeMatch;
    let hour = Number(rawHour);
    const parsedMinute = Number(minute);
    const parsedSecond = Number(second);

    if (meridiem) {
      const normalizedMeridiem = meridiem.toUpperCase();
      if (hour >= 1 && hour <= 12) {
        if (normalizedMeridiem === "PM" && hour < 12) {
          hour += 12;
        } else if (normalizedMeridiem === "AM" && hour === 12) {
          hour = 0;
        }
      }
    }

    return parseDateValue([
      Number(year),
      Number(month),
      Number(day),
      hour,
      parsedMinute,
      parsedSecond,
    ]);
  }

  const slashDateMatch = normalizedValue.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})[- T](\d{1,2}):(\d{2}):(\d{2})$/,
  );
  if (slashDateMatch) {
    const [, day, month, year, hour, minute, second] = slashDateMatch;
    return parseDateValue([
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ]);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildReferenceSource(record, fallbackSource) {
  const statusSource = record?.last_status_con_source;
  if (fallbackSource === "last_status_con_at" && statusSource) {
    return `last_status_con_at:${statusSource}`;
  }

  return fallbackSource;
}

function getFreshnessCandidates(record) {
  const status = (record?.status || "").toString().trim().toLowerCase();
  const candidates = [
    {
      source: "rooms.updated_at",
      rawValue: record?.room_updated_at,
    },
    {
      source: "realnews.updated_at",
      rawValue: record?.building_updated_at,
    },
  ];

  if (status === "con" && record?.last_status_con_at) {
    candidates.push({
      source: buildReferenceSource(record, "last_status_con_at"),
      rawValue: record.last_status_con_at,
    });
  }

  return candidates.filter((candidate) => candidate.rawValue);
}

function applyRule1Update(record, options = {}) {
  const nextRecord = { ...record };
  const reasons = [];
  const thresholdHours = Number.isFinite(options?.thresholdHours)
    ? options.thresholdHours
    : 24;
  const freshnessCandidates = getFreshnessCandidates(nextRecord);
  const parsedCandidates = freshnessCandidates
    .map((candidate) => ({
      ...candidate,
      parsedDate: parseDateValue(candidate.rawValue),
    }))
    .filter((candidate) => candidate.parsedDate);
  const selectedCandidate =
    parsedCandidates.length > 0
      ? parsedCandidates.reduce((latest, candidate) =>
          candidate.parsedDate.getTime() > latest.parsedDate.getTime()
            ? candidate
            : latest,
        )
      : null;

  nextRecord.rule_1_reference_at = selectedCandidate?.rawValue || null;
  nextRecord.rule_1_reference_source = selectedCandidate?.source || null;

  if (freshnessCandidates.length === 0) {
    nextRecord.rule_1_status = "SKIP";
    nextRecord.rule_1_reason = ["UPDATED_AT_MISSING"];
    return nextRecord;
  }

  if (!selectedCandidate) {
    nextRecord.rule_1_status = "FAIL";
    nextRecord.rule_1_reason = ["UPDATED_AT_INVALID"];
    return nextRecord;
  }

  const ageMs = Date.now() - selectedCandidate.parsedDate.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  nextRecord.rule_1_age_hours = Number(ageHours.toFixed(2));
  nextRecord.last_updated_at = selectedCandidate.rawValue || null;
  nextRecord.last_updated_source =
    selectedCandidate.source || nextRecord.last_updated_source || null;

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
