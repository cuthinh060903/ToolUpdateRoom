// const extension = {
//   "1WC": ["vskk"],
//   "2WC": ["2wc", "2 vệ sinh"],
//   "1N": ["1pn"],
//   "2N": ["2pn", "2 ngủ", "2n"],
//   "3N": ["3pn", "3 ngủ"],
//   "BC": ["bc", "ban công"],
//   "GX": ["gx", "gác xép"],
//   "1K": ["studio", "phòng khách", "1k"]
// };

// module.exports = { extension };

const extension = {
  "1WC": ["vskk"],
  "2WC": ["2wc", "2 vệ sinh"],
  "1N": ["1pn"],
  "2N": ["2pn", "2 ngủ", "2n"],
  "3N": ["3pn", "3 ngủ"],
  BC: ["bc", "ban công"],
  GX: ["gx", "gác xép"],
  "1K": ["studio", "phòng khách", "1k"],
};

const roomNameAliases = {
  "1k1n": ["1k1n", "1n1k", "1kin", "1 ngủ 1 khách", "1 ngu 1 khach"],
  "2k1n": ["2k1n", "2n1k", "2kin", "2 ngủ 1 khách", "2 ngu 1 khach"],
  studio: ["studio"],
  homestay: ["homestay"],
  ccmn: ["ccmn", "chung cư mini", "chung cu mini"],
};

module.exports = { extension, roomNameAliases };
