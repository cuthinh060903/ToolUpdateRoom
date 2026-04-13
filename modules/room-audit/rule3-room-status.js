function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function applyRule3RoomStatus(record) {
  const nextRecord = { ...record };
  const reasons = [];
  const status = (nextRecord.status || "").toLowerCase();
  const hasCapNhatTrongLog = (nextRecord.log_matches?.capnhattrong || []).length > 0;
  const hasCreateRoomFailedLog = (nextRecord.log_matches?.taophongloi || []).length > 0;

  if (!nextRecord.mapping?.building_matched) {
    reasons.push("BUILDING_NOT_FOUND");
  }

  if (nextRecord.mapping?.building_matched && !nextRecord.mapping?.room_matched) {
    reasons.push("ROOM_NOT_FOUND");
  }

  if (hasCreateRoomFailedLog) {
    reasons.push("CREATE_ROOM_FAILED_LOGGED");
  }

  if (nextRecord.api_errors?.search_room) {
    reasons.push("SEARCH_ROOM_API_ERROR");
  }

  if (nextRecord.mapping?.room_matched && !status) {
    reasons.push("ROOM_STATUS_MISSING");
  }

  if (nextRecord.mapping?.room_matched && status && status !== "con") {
    reasons.push(`ROOM_STATUS_${status.toUpperCase()}`);
  }

  if (
    nextRecord.mapping?.room_matched &&
    status &&
    status !== "con" &&
    nextRecord.empty_room_date
  ) {
    reasons.push("ROOM_STILL_HAS_EMPTY_ROOM_DATE");
  }

  if (
    nextRecord.mapping?.room_matched &&
    (!status || status !== "con") &&
    !hasCapNhatTrongLog
  ) {
    reasons.push("CAPNHATTRONG_LOG_MISSING");
  }

  if (
    !nextRecord.mapping?.room_matched &&
    nextRecord.room_name &&
    !hasCapNhatTrongLog
  ) {
    reasons.push("SHEET_ROOM_NOT_UPDATED_TO_EMPTY");
  }

  nextRecord.rule_3_reason = unique(reasons);
  nextRecord.rule_3_status =
    nextRecord.rule_3_reason.length > 0 ? "FAIL" : "PASS";
  return nextRecord;
}

module.exports = {
  applyRule3RoomStatus,
};
