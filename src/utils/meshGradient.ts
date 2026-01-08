/**
 * Mesh Gradient Generator for brainbox
 *
 * Generates procedural, textured gradient images for vault cover images.
 * Uses a deterministic PRNG to ensure the same seed always produces the same gradient.
 */

/**
 * Creates a Mulberry32 PRNG function from a numeric seed.
 * Mulberry32 is a simple, fast, high-quality 32-bit PRNG.
 *
 * @param seed - Initial seed value
 * @returns A function that returns pseudo-random numbers between 0 and 1
 */
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hashes a string to a 32-bit unsigned integer using FNV-1a algorithm
 *
 * @param str - String to hash
 * @returns 32-bit unsigned integer hash
 */
function hashString(str: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Generates a random muted HSL color suitable for gradients
 *
 * @param rand - PRNG function
 * @returns HSL color string with muted saturation (30-60%) and mid lightness (40-65%)
 */
function randomMutedColor(rand: () => number) {
  const h = Math.floor(rand() * 360);
  const s = 30 + Math.floor(rand() * 30); // 30-60%
  const l = 40 + Math.floor(rand() * 25); // 40-65%
  return `hsl(${h} ${s}% ${l}%)`;
}

/**
 * Options for mesh gradient generation
 */
export interface MeshGradientOptions {
  /** Seed string for deterministic generation */
  seed?: string;
  /** Output width in pixels (default: 640) */
  width?: number;
  /** Output height in pixels (default: 420) */
  height?: number;
  /** Number of gradient colors, 3-5 typical (default: random 3-5) */
  colorsCount?: number;
  /** Noise intensity 0-1 (default: 0.08) */
  noise?: number;
}

/**
 * Generates a noisy, textured mesh-style gradient as a data URL.
 *
 * Creates a visually appealing gradient by layering multiple radial gradients
 * with screen/overlay blending, then adding fine noise for texture.
 * Deterministic if a seed is provided - same seed always produces same result.
 *
 * @param opts - Generation options
 * @returns PNG data URL of the generated gradient image
 *
 * @example
 * // Generate a random gradient
 * const url1 = generateMeshGradientDataURL();
 *
 * // Generate a deterministic gradient for a specific vault
 * const url2 = generateMeshGradientDataURL({ seed: 'vault-123', width: 800, height: 600 });
 */
export function generateMeshGradientDataURL(opts: MeshGradientOptions = {}): string {
  const width = opts.width ?? 640;
  const height = opts.height ?? 420;
  const colorsCount = Math.max(3, Math.min(5, opts.colorsCount ?? (3 + Math.floor(Math.random() * 3))));
  const noiseIntensity = Math.min(1, Math.max(0, opts.noise ?? 0.08));

  const seedNum = opts.seed ? hashString(opts.seed) : Math.floor(Math.random() * 2 ** 32);
  const rand = mulberry32(seedNum);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Base fill
  ctx.fillStyle = randomMutedColor(rand);
  ctx.fillRect(0, 0, width, height);

  // Draw several overlapping radial gradients to emulate a mesh
  const blobs = colorsCount + 2; // a few extra for richness
  for (let i = 0; i < blobs; i++) {
    const x = Math.floor(rand() * width);
    const y = Math.floor(rand() * height);
    const r = Math.max(width, height) * (0.4 + rand() * 0.8);
    const color = randomMutedColor(rand);

    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'transparent');

    ctx.globalAlpha = 0.6 + rand() * 0.25; // 0.6-0.85
    ctx.globalCompositeOperation = i % 2 === 0 ? 'screen' : 'overlay';
    ctx.fillStyle = grad as unknown as string;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Add fine noise for texture
  if (noiseIntensity > 0) {
    // Generate full-size noise to avoid tiling artifacts
    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = width;
    noiseCanvas.height = height;
    const nctx = noiseCanvas.getContext('2d');
    if (nctx) {
      const imgData = nctx.createImageData(width, height);
      // Precompute base alpha for noise and allow slight per-pixel variance
      const baseA = Math.max(0, Math.min(1, noiseIntensity));
      for (let i = 0; i < imgData.data.length; i += 4) {
        const v = Math.floor(rand() * 255);
        imgData.data[i] = v;
        imgData.data[i + 1] = v;
        imgData.data[i + 2] = v;
        // Slight randomization to reduce banding
        const aJitter = baseA * (0.85 + rand() * 0.3); // ~0.85x - 1.15x
        imgData.data[i + 3] = Math.floor(255 * aJitter * 0.35); // global strength ~0.35
      }
      nctx.putImageData(imgData, 0, 0);

      // Composite the full-size noise with an overlay blend
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'overlay';
      ctx.drawImage(noiseCanvas, 0, 0);
    }
  }

  // Restore defaults
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  return canvas.toDataURL('image/png');
}

/**
 * Convenience function to generate a mesh gradient for a specific ID.
 *
 * @param id - Vault or item ID (used as seed for deterministic generation)
 * @param width - Output width in pixels (default: 640)
 * @param height - Output height in pixels (default: 420)
 * @returns PNG data URL of the generated gradient image
 *
 * @example
 * // Generate a cover image for vault ID 123
 * const coverUrl = meshGradientForId('123');
 */
export function meshGradientForId(id: string | number, width?: number, height?: number): string {
  return generateMeshGradientDataURL({ seed: String(id), width, height });
}
