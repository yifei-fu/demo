/** Device, canvas and HDR configuration, resize policy and small helpers. */

export interface Gpu {
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  /** true when the canvas is rgba16float with extended tone mapping (linear, 1.0 = SDR white). */
  extended: boolean;
  /** Peak brightness relative to SDR white: ~1.0 on SDR displays, ~1.7 on HDR ones. */
  hdrHeadroom: number;
  /** Largest pixel count the accumulation buffer may hold (storage binding limit / 16 B). */
  maxPixels: number;
  /** Resolves with a human-readable reason when the device is lost. */
  lost: Promise<string>;
}

export interface GpuOptions {
  /** `0` forces the SDR path, `1` forces the HDR path even without an HDR display. */
  hdr: '0' | '1' | 'auto';
}

const HDR_HEADROOM = 1.7;
const BYTES_PER_PIXEL = 16;

export async function initGpu(canvas: HTMLCanvasElement, opts: GpuOptions): Promise<Gpu | null> {
  if (!('gpu' in navigator)) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;

  const wanted = ['maxStorageBufferBindingSize', 'maxBufferSize'] as const;
  const requiredLimits: Record<string, number> = {};
  for (const k of wanted) requiredLimits[k] = adapter.limits[k];

  const device = await adapter.requestDevice({ requiredLimits });
  device.onuncapturederror = (e) => console.error('[axiom] WebGPU error:', e.error.message);
  const lost = device.lost.then((info) =>
    info.reason === 'destroyed' ? 'destroyed' : info.message || 'the GPU device was lost',
  );

  const context = canvas.getContext('webgpu');
  if (!context) return null;

  const extended = opts.hdr !== '0' && configureExtended(context, device);
  let format: GPUTextureFormat = 'rgba16float';
  if (!extended) {
    format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
  }

  const hdrHeadroom = extended ? headroomFor(opts) : 1;
  const maxPixels = Math.floor(device.limits.maxStorageBufferBindingSize / BYTES_PER_PIXEL);
  return { device, canvas, context, format, extended, hdrHeadroom, maxPixels, lost };
}

function headroomFor(opts: GpuOptions): number {
  if (opts.hdr === '1') return HDR_HEADROOM;
  const hdrDisplay = typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches;
  return hdrDisplay ? HDR_HEADROOM : 1;
}

/** Feature detection: configure() may throw, or silently ignore toneMapping on older engines. */
function configureExtended(context: GPUCanvasContext, device: GPUDevice): boolean {
  try {
    context.configure({
      device,
      format: 'rgba16float',
      alphaMode: 'opaque',
      toneMapping: { mode: 'extended' },
    });
    const cfg = context.getConfiguration?.();
    return cfg?.format === 'rgba16float' && cfg.toneMapping?.mode === 'extended';
  } catch {
    return false;
  }
}

/** Canvas backing size for a CSS size: DPR capped at 2, times the adaptive scale, memory-bounded. */
export function backingSize(
  gpu: Gpu,
  cssW: number,
  cssH: number,
  scale: number,
): { width: number; height: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
  let w = Math.max(2, Math.round(cssW * dpr));
  let h = Math.max(2, Math.round(cssH * dpr));
  const over = (w * h) / gpu.maxPixels;
  if (over > 1) {
    const k = 1 / Math.sqrt(over);
    w = Math.max(2, Math.floor(w * k));
    h = Math.max(2, Math.floor(h * k));
  }
  return { width: w, height: h };
}

/** Watch the display for HDR capability changes (window dragged to another monitor). */
export function watchHdr(gpu: Gpu, opts: GpuOptions): void {
  if (!gpu.extended || opts.hdr !== 'auto' || typeof matchMedia !== 'function') return;
  matchMedia('(dynamic-range: high)').addEventListener('change', () => {
    gpu.hdrHeadroom = headroomFor(opts);
  });
}

/** Compile a shader module and surface any diagnostics on the console. */
export function createShader(device: GPUDevice, code: string, label: string): GPUShaderModule {
  const module = device.createShaderModule({ label, code });
  void module.getCompilationInfo().then((info) => {
    for (const m of info.messages) {
      const text = `[axiom] ${label}:${m.lineNum}:${m.linePos} ${m.message}`;
      if (m.type === 'error') console.error(text);
      else console.warn(text);
    }
  });
  return module;
}

export function createUniform(device: GPUDevice, bytes: number, label: string): GPUBuffer {
  return device.createBuffer({
    label,
    size: bytes,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}
