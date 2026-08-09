export type Rgb = [number, number, number];
export type Lab = [number, number, number];

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const srgbChannelToLinear = (value: number) => {
  const channel = clamp01(value / 255);
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
};

export const rgbToLab = ([red, green, blue]: Rgb): Lab => {
  const r = srgbChannelToLinear(red);
  const g = srgbChannelToLinear(green);
  const b = srgbChannelToLinear(blue);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const pivot = (value: number) => value > 216 / 24389
    ? Math.cbrt(value)
    : (24389 / 27 * value + 16) / 116;
  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

const degrees = (radians: number) => radians * 180 / Math.PI;
const radians = (degreesValue: number) => degreesValue * Math.PI / 180;
const hueDegrees = (a: number, b: number) => {
  if (a === 0 && b === 0) return 0;
  const hue = degrees(Math.atan2(b, a));
  return hue >= 0 ? hue : hue + 360;
};

export const ciede2000 = (left: Lab, right: Lab) => {
  const [l1, a1, b1] = left;
  const [l2, a2, b2] = right;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const averageC = (c1 + c2) / 2;
  const averageC7 = averageC ** 7;
  const g = 0.5 * (1 - Math.sqrt(averageC7 / (averageC7 + 25 ** 7)));
  const adjustedA1 = (1 + g) * a1;
  const adjustedA2 = (1 + g) * a2;
  const adjustedC1 = Math.hypot(adjustedA1, b1);
  const adjustedC2 = Math.hypot(adjustedA2, b2);
  const h1 = hueDegrees(adjustedA1, b1);
  const h2 = hueDegrees(adjustedA2, b2);
  const deltaL = l2 - l1;
  const deltaC = adjustedC2 - adjustedC1;
  const hueDifference = adjustedC1 * adjustedC2 === 0
    ? 0
    : Math.abs(h2 - h1) <= 180
      ? h2 - h1
      : h2 <= h1
        ? h2 - h1 + 360
        : h2 - h1 - 360;
  const deltaH = 2 * Math.sqrt(adjustedC1 * adjustedC2) * Math.sin(radians(hueDifference / 2));
  const averageL = (l1 + l2) / 2;
  const adjustedAverageC = (adjustedC1 + adjustedC2) / 2;
  const averageH = adjustedC1 * adjustedC2 === 0
    ? h1 + h2
    : Math.abs(h1 - h2) <= 180
      ? (h1 + h2) / 2
      : h1 + h2 < 360
        ? (h1 + h2 + 360) / 2
        : (h1 + h2 - 360) / 2;
  const t = 1
    - 0.17 * Math.cos(radians(averageH - 30))
    + 0.24 * Math.cos(radians(2 * averageH))
    + 0.32 * Math.cos(radians(3 * averageH + 6))
    - 0.2 * Math.cos(radians(4 * averageH - 63));
  const deltaTheta = 30 * Math.exp(-(((averageH - 275) / 25) ** 2));
  const adjustedAverageC7 = adjustedAverageC ** 7;
  const rc = 2 * Math.sqrt(adjustedAverageC7 / (adjustedAverageC7 + 25 ** 7));
  const lightnessTerm = averageL - 50;
  const sl = 1 + 0.015 * lightnessTerm ** 2 / Math.sqrt(20 + lightnessTerm ** 2);
  const sc = 1 + 0.045 * adjustedAverageC;
  const sh = 1 + 0.015 * adjustedAverageC * t;
  const rt = -Math.sin(radians(2 * deltaTheta)) * rc;
  const normalizedL = deltaL / sl;
  const normalizedC = deltaC / sc;
  const normalizedH = deltaH / sh;
  return Math.sqrt(
    normalizedL ** 2
    + normalizedC ** 2
    + normalizedH ** 2
    + rt * normalizedC * normalizedH,
  );
};
