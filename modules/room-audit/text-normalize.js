const VIETNAMESE_CHAR_PATTERN =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/g;
const MOJIBAKE_PATTERN =
  /(?:Ã.|Â.|Ä.|Æ.|Ð.|Ñ.|Ò.|Ó.|Ô.|Õ.|Ö.|Ø.|Ù.|Ú.|Û.|Ü.|Ý.|Þ.|ß.|á»|áº|á¸|â€|Â |[»¼½¾¿¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶])/g;

function countMatches(value = "", pattern) {
  const matches = value.match(pattern);
  return matches ? matches.length : 0;
}

function repairVietnameseText(value = "") {
  if (value === undefined || value === null) {
    return "";
  }

  const text = value.toString();
  if (!text) {
    return text;
  }

  let repaired = "";
  try {
    repaired = Buffer.from(text, "latin1").toString("utf8");
  } catch {
    return text;
  }

  if (!repaired || repaired.includes("\uFFFD")) {
    return text;
  }

  const originalSuspicious = countMatches(text, MOJIBAKE_PATTERN);
  const repairedSuspicious = countMatches(repaired, MOJIBAKE_PATTERN);
  const originalVietnamese = countMatches(text, VIETNAMESE_CHAR_PATTERN);
  const repairedVietnamese = countMatches(repaired, VIETNAMESE_CHAR_PATTERN);
  const looksImproved =
    repairedSuspicious < originalSuspicious &&
    (originalSuspicious > 0 || repairedVietnamese > originalVietnamese);

  return looksImproved ? repaired : text;
}

function normalizeVietnameseKey(value = "") {
  return repairVietnameseText(value).trim().toLowerCase();
}

module.exports = {
  normalizeVietnameseKey,
  repairVietnameseText,
};
