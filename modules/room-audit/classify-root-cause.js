const ROOT_CAUSE = {
  ADDRESS_BUILDING: "ADDRESS_BUILDING",
  ROOM_NAME: "ROOM_NAME",
  DOWNSTREAM_BUILDING_UNRESOLVED: "DOWNSTREAM_BUILDING_UNRESOLVED",
  UNKNOWN: "UNKNOWN",
};

const HARD_BUILDING_REJECT_REASONS = new Set([
  "house_number_mismatch",
  "number_token_mismatch",
  "compound_number_mismatch",
]);

const SOFT_BUILDING_REJECT_REASONS = new Set([
  "score_below_threshold",
  "keyword_below_threshold",
  "number_below_threshold",
  "address_too_generic",
]);

function normalizeKeyText(value = "") {
  return value.toString().trim().toLowerCase();
}

function buildAddressBusinessKey(row = {}) {
  return [normalizeKeyText(row.cdt_id), normalizeKeyText(row.address)].join("|");
}

function hasReason(row = {}, fieldName = "", reason = "") {
  if (!fieldName || !reason) {
    return false;
  }

  return Array.isArray(row[fieldName]) && row[fieldName].includes(reason);
}

function hasAnyFail(row = {}) {
  return (
    row.rule_1_status === "FAIL" ||
    row.rule_2_status === "FAIL" ||
    row.rule_3_status === "FAIL" ||
    row.rule_4_status === "FAIL"
  );
}

function buildRootCauseEvidence(rows = []) {
  const sameAddressBuildingSignals = new Set();

  rows.forEach((row) => {
    const addressKey = buildAddressBusinessKey(row);
    const hasCapNhatTrongLog =
      Array.isArray(row.log_matches?.capnhattrong) &&
      row.log_matches.capnhattrong.length > 0;
    const buildingMatched = Boolean(row.mapping?.building_matched);
    const roomExistsOnAnyCandidate = row.room_exists_on_any_candidate === true;

    if (addressKey && (hasCapNhatTrongLog || buildingMatched || roomExistsOnAnyCandidate)) {
      sameAddressBuildingSignals.add(addressKey);
    }
  });

  return {
    sameAddressBuildingSignals,
  };
}

function formatScore(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "";
}

function classifyRootCause(row = {}, evidence = {}) {
  if (!hasAnyFail(row)) {
    return {
      root_cause: "",
      root_cause_note: "",
      root_cause_source: "",
    };
  }

  const buildingMatched = Boolean(row.mapping?.building_matched);
  const roomMatched = Boolean(row.mapping?.room_matched);

  if (buildingMatched && !roomMatched) {
    return {
      root_cause: ROOT_CAUSE.ROOM_NAME,
      root_cause_note: "Building da match nhung room chua match.",
      root_cause_source: "derived",
    };
  }

  const buildingFailed =
    !buildingMatched ||
    hasReason(row, "rule_2_reason", "BUILDING_NOT_MATCHED") ||
    hasReason(row, "rule_3_reason", "BUILDING_NOT_FOUND");

  if (!buildingFailed) {
    return {
      root_cause: ROOT_CAUSE.UNKNOWN,
      root_cause_note:
        "Row co canh bao nhung khong roi vao nhanh building/room mapping.",
      root_cause_source: "derived",
    };
  }

  const rejectReason = (row.top_building_candidate_reject_reason || "").trim();
  const hasTopCandidate = Boolean(row.top_building_candidate_id);
  const topScore = Number(row.top_building_candidate_score);
  const hasAddressMismatch = hasReason(
    row,
    "rule_2_reason",
    "ADDRESS_MISMATCH_LOGGED",
  );
  const hasSameAddressSignal = evidence.sameAddressBuildingSignals?.has(
    buildAddressBusinessKey(row),
  );
  const roomExistsOnTopCandidate = row.room_exists_on_top_candidate;
  const roomExistsOnAnyCandidate = row.room_exists_on_any_candidate;

  if (roomExistsOnTopCandidate === true || roomExistsOnAnyCandidate === true) {
    return {
      root_cause: ROOT_CAUSE.ADDRESS_BUILDING,
      root_cause_note:
        "Fail o buoc building va da thay room tren candidate building.",
      root_cause_source: "derived",
    };
  }

  if (hasSameAddressSignal) {
    return {
      root_cause: ROOT_CAUSE.ADDRESS_BUILDING,
      root_cause_note:
        "Cung dia chi da co signal building o log/row khac, nghieng ve ADDRESS_BUILDING.",
      root_cause_source: "derived",
    };
  }

  if (hasTopCandidate && SOFT_BUILDING_REJECT_REASONS.has(rejectReason)) {
    const scoreSuffix = formatScore(topScore);
    return {
      root_cause: ROOT_CAUSE.ADDRESS_BUILDING,
      root_cause_note: scoreSuffix
        ? `Top candidate bi reject mem (${rejectReason}) voi score ${scoreSuffix}.`
        : `Top candidate bi reject mem (${rejectReason}).`,
      root_cause_source: "derived",
    };
  }

  if (!hasTopCandidate) {
    return {
      root_cause: ROOT_CAUSE.DOWNSTREAM_BUILDING_UNRESOLVED,
      root_cause_note:
        "Chua co top building candidate de chot nguyen nhan business.",
      root_cause_source: "derived",
    };
  }

  if (HARD_BUILDING_REJECT_REASONS.has(rejectReason)) {
    return {
      root_cause: ROOT_CAUSE.DOWNSTREAM_BUILDING_UNRESOLVED,
      root_cause_note: `Top candidate bi reject cung (${rejectReason}).`,
      root_cause_source: "derived",
    };
  }

  if (hasAddressMismatch) {
    return {
      root_cause: ROOT_CAUSE.DOWNSTREAM_BUILDING_UNRESOLVED,
      root_cause_note:
        "Co ADDRESS_MISMATCH_LOGGED nhung signal hien tai chua du de chot building.",
      root_cause_source: "derived",
    };
  }

  return {
    root_cause: ROOT_CAUSE.UNKNOWN,
    root_cause_note:
      "Signal hien tai chua du de quy ve ADDRESS_BUILDING hay ROOM_NAME.",
    root_cause_source: "derived",
  };
}

function applyRootCauseClassification(rows = []) {
  const evidence = buildRootCauseEvidence(rows);

  return rows.map((row) => ({
    ...row,
    ...classifyRootCause(row, evidence),
  }));
}

function summarizeRootCauses(rows = []) {
  return rows.reduce(
    (summary, row) => {
      const rootCause = row.root_cause || "";
      if (rootCause) {
        summary[rootCause] = (summary[rootCause] || 0) + 1;
      }
      return summary;
    },
    {
      [ROOT_CAUSE.ADDRESS_BUILDING]: 0,
      [ROOT_CAUSE.ROOM_NAME]: 0,
      [ROOT_CAUSE.DOWNSTREAM_BUILDING_UNRESOLVED]: 0,
      [ROOT_CAUSE.UNKNOWN]: 0,
    },
  );
}

module.exports = {
  ROOT_CAUSE,
  applyRootCauseClassification,
  summarizeRootCauses,
};
