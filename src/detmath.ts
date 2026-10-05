// Deterministic math for simulation code (from Craft Ones' packages/shared, extended). Math.sin, Math.cos, Math.exp and Math.hypot are not specified to the
// last bit, and engines differ (JavaScriptCore on macOS and on Linux disagreed and broke the golden replays), so
// two peers on different platforms would drift apart. These use only +, -, *, / and Math.sqrt, which IEEE 754
// fixes exactly, with fdlibm's kernels. Accuracy is within a couple of ulps, far below anything a player sees.

const PIO2_HI = 1.5707963267341256; // first 33 bits of pi/2
const PIO2_LO = 6.077100506506192e-11; // pi/2 - PIO2_HI
const TWO_OVER_PI = 0.6366197723675814;

// fdlibm __kernel_sin and __kernel_cos on [-pi/4, pi/4].
function kernelSin(x: number): number {
  const z = x * x;
  const v = z * x;
  const r =
    0.00833333333332249 +
    z *
      (-0.0001984126982985795 +
        z *
          (2.7557313707070068e-6 +
            z * (-2.5050760253406863e-8 + z * 1.58969099521155e-10)));
  return x + v * (-0.16666666666666632 + z * r);
}

function kernelCos(x: number): number {
  const z = x * x;
  const r =
    z *
    (0.0416666666666666 +
      z *
        (-0.001388888888887411 +
          z *
            (2.480158728947673e-5 +
              z *
                (-2.7557314351390663e-7 +
                  z * (2.087572321298175e-9 + z * -1.1359647557788195e-11)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (1 - w - hz + z * r);
}

// Cody-Waite reduction; game angles stay within a few turns, where it is exact enough.
function reduce(x: number): { r: number; q: number } {
  const k = Math.round(x * TWO_OVER_PI);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  return { r, q: ((k % 4) + 4) % 4 };
}

export function dsin(x: number): number {
  const { r, q } = reduce(x);
  return q === 0
    ? kernelSin(r)
    : q === 1
      ? kernelCos(r)
      : q === 2
        ? -kernelSin(r)
        : -kernelCos(r);
}

export function dcos(x: number): number {
  const { r, q } = reduce(x);
  return q === 0
    ? kernelCos(r)
    : q === 1
      ? -kernelSin(r)
      : q === 2
        ? -kernelCos(r)
        : kernelSin(r);
}

// fdlibm exp: x = k*ln2 + r, |r| <= ln2/2, then a rational approximation of e^r.
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = Math.LOG2E;
export function dexp(x: number): number {
  if (x > 709) return Number.POSITIVE_INFINITY;
  if (x < -745) return 0;
  const k = Math.round(x * INV_LN2);
  const hi = x - k * LN2_HI;
  const lo = k * LN2_LO;
  const r = hi - lo;
  const t = r * r;
  const c =
    r -
    t *
      (0.16666666666666602 +
        t *
          (-0.0027777777777015593 +
            t *
              (6.613756321437934e-5 +
                t * (-1.6533902205465252e-6 + t * 4.1381367970572385e-8))));
  let y = 1 - (lo - (r * c) / (2 - c) - hi);
  // Scale by 2^k with exact multiplications.
  let n = k;
  while (n > 0) {
    y *= 2;
    n -= 1;
  }
  while (n < 0) {
    y *= 0.5;
    n += 1;
  }
  return y;
}

export function dtan(x: number): number {
  const { r, q } = reduce(x);
  const s = kernelSin(r);
  const c = kernelCos(r);
  return q % 2 === 0 ? s / c : -c / s;
}

// fdlibm log: x = 2^k * (1 + f) with sqrt(2)/2 <= 1 + f < sqrt(2), then a polynomial in s = f / (2 + f).
export function dlog(x: number): number {
  if (Number.isNaN(x) || x < 0) return Number.NaN;
  if (x === 0) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return x;
  let m = x;
  let k = 0;
  // Exact power-of-two scaling, no bit access.
  while (m >= 2) {
    m *= 0.5;
    k += 1;
  }
  while (m < 1) {
    m *= 2;
    k -= 1;
  }
  if (m > Math.SQRT2) {
    m *= 0.5;
    k += 1;
  }
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (0.3999999999940942 + w * (0.22222198432149784 + w * 0.15313837699209373));
  const t2 = z * (0.6666666666666735 + w * (0.2857142874366239 + w * (0.1818357216161805 + w * 0.14798198605116586)));
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - (hfsq - (s * (hfsq + t1 + t2) + k * LN2_LO) - f);
}

// fdlibm atan: reduce |x| to a small argument around 0, 0.5, 1, 1.5 or infinity, then a polynomial.
const ATAN_HI = [0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966];
const ATAN_LO = [2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17];
export function datan(x: number): number {
  if (Number.isNaN(x)) return x;
  const negative = x < 0;
  let t = negative ? -x : x;
  let id = -1;
  if (t >= 0.4375) {
    if (t < 0.6875) {
      id = 0;
      t = (2 * t - 1) / (2 + t);
    } else if (t < 1.1875) {
      id = 1;
      t = (t - 1) / (t + 1);
    } else if (t < 2.4375) {
      id = 2;
      t = (t - 1.5) / (1 + 1.5 * t);
    } else {
      id = 3;
      t = -1 / t;
    }
  }
  const z = t * t;
  const w = z * z;
  const s1 =
    z *
    (0.3333333333333293 +
      w * (0.14285714272503466 + w * (0.09090887133436507 + w * (0.06661073137387531 + w * (0.049768779946159324 + w * 0.016285820115365782)))));
  const s2 = w * (-0.19999999999876483 + w * (-0.11111110405462356 + w * (-0.0769187620504483 + w * (-0.058335701337905735 + w * -0.036531572744216916))));
  const result = id < 0 ? t - t * (s1 + s2) : ATAN_HI[id] - (t * (s1 + s2) - ATAN_LO[id] - t);
  return negative ? -result : result;
}

const PI_LO = 1.2246467991473532e-16;
export function datan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x === 0) return y === 0 ? (1 / x < 0 ? (1 / y < 0 ? -Math.PI : Math.PI) : y) : y > 0 ? Math.PI / 2 : -Math.PI / 2;
  const z = datan(Math.abs(y / x));
  const angle = x > 0 ? z : Math.PI - (z - PI_LO);
  return y < 0 || (y === 0 && 1 / y < 0) ? -angle : angle;
}

// Integer exponents multiply exactly; anything else goes through dexp and dlog (deterministic, a few ulps).
export function dpow(x: number, y: number): number {
  if (Number.isInteger(y) && Math.abs(y) <= 64) {
    let result = 1;
    let base = y < 0 ? 1 / x : x;
    let n = Math.abs(y);
    while (n > 0) {
      if (n % 2 === 1) result *= base;
      base *= base;
      n = Math.floor(n / 2);
    }
    return result;
  }
  if (x === 0) return y > 0 ? 0 : Number.POSITIVE_INFINITY;
  if (x < 0) return Number.isInteger(y) ? (y % 2 === 0 ? 1 : -1) * dexp(y * dlog(-x)) : Number.NaN;
  return dexp(y * dlog(x));
}

export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

// An angle wrapped to (-pi, pi], without atan2.
const TAU = 6.283185307179586;
export function wrapAngle(a: number): number {
  let w = a - TAU * Math.round(a / TAU);
  if (w <= -Math.PI) w += TAU;
  return w;
}

export function sq(x: number): number {
  return x * x;
}
