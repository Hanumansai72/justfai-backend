/** Semantic version comparison — returns true if `candidate` is newer than `current` */
const isNewerVersion = (current, candidate) => {
  if (!current) return true;
  const parse = (v) => String(v).replace(/^v/i, "").split(".").map(part => parseInt(part, 10) || 0);
  const [cA, cB = 0, cC = 0] = parse(current);
  const [nA, nB = 0, nC = 0] = parse(candidate);
  if (nA !== cA) return nA > cA;
  if (nB !== cB) return nB > cB;
  return nC > cC;
};


module.exports = isNewerVersion;
