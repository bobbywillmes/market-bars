export function addATR(bars, length = 14) {
  if (!bars || bars.length === 0) return bars;

  const out = bars.map(b => ({ ...b }));

  // True Range
  for (let i = 0; i < out.length; i++) {
    const prevClose = i > 0 ? out[i - 1].c : null;
    const highLow = out[i].h - out[i].l;

    if (prevClose == null) {
      out[i].tr = highLow;
    } else {
      out[i].tr = Math.max(
        highLow,
        Math.abs(out[i].h - prevClose),
        Math.abs(out[i].l - prevClose)
      );
    }
  }

  // Wilder ATR
  for (let i = 0; i < out.length; i++) {
    if (i < length - 1) {
      out[i].atr14 = null;
      continue;
    }

    if (i === length - 1) {
      let sum = 0;
      for (let j = 0; j < length; j++) sum += out[j].tr;
      out[i].atr14 = sum / length;
    } else {
      out[i].atr14 =
        (out[i - 1].atr14 * (length - 1) + out[i].tr) / length;
    }
  }

  return out;
}
