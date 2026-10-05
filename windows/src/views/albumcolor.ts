// The colour of an album cover, for the Spotify Mochi, her pill and the player:
// the most saturated hue that covers a real part of the art, brightened so it
// reads on the island's black. Spotify's image CDN sends CORS headers, so the
// pixels can be read; a cover that cannot be read gives null (Spotify green).

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

/** The colour already worked out for this cover, without waiting. */
export function cachedAlbumColor(url: string): string | null | undefined {
  return cache.get(url);
}

export function albumColor(url: string): Promise<string | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url)!);
  const inFlight = pending.get(url);
  if (inFlight) return inFlight;
  const p = new Promise<string | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(fromImage(img));
    img.onerror = () => resolve(null);
    img.src = url;
  }).then((c) => {
    cache.set(url, c);
    pending.delete(url);
    // Covers change a few times an hour: a handful is plenty.
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return c;
  });
  pending.set(url, p);
  return p;
}

function fromImage(img: HTMLImageElement): string | null {
  const N = 24;
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  let px: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, N, N);
    px = ctx.getImageData(0, 0, N, N).data;
  } catch {
    // Tainted canvas: the host sent no CORS headers.
    return null;
  }

  // Twelve hue buckets, each pixel weighted by how colourful it is; greys,
  // near-black and near-white count for nothing.
  const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    const [h, s, l] = hsl(r, g, b);
    if (s < 0.22 || l < 0.12 || l > 0.92) continue;
    const w = s * (1 - Math.abs(l - 0.55) * 1.3);
    if (w <= 0) continue;
    const bin = bins[Math.floor(h * 12) % 12];
    bin.w += w;
    bin.r += r * w;
    bin.g += g * w;
    bin.b += b * w;
    total += w;
  }
  // Under ~6 % of the cover in colour: a black-and-white sleeve keeps the green.
  if (total < N * N * 0.06) return null;
  const best = bins.reduce((a, c) => (c.w > a.w ? c : a));
  const [h, s] = hsl(best.r / best.w, best.g / best.w, best.b / best.w);
  return hex(h, Math.max(0.5, Math.min(0.85, s)), 0.62);
}

function hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
