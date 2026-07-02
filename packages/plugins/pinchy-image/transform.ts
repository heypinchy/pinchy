import sharp from "sharp";

export type ResizeFit = "cover" | "contain" | "fill" | "inside";
export type ConvertFormat = "png" | "jpeg" | "webp";

const ALLOWED_FITS: ReadonlyArray<ResizeFit> = ["cover", "contain", "fill", "inside"];
const ALLOWED_FORMATS: ReadonlyArray<ConvertFormat> = ["png", "jpeg", "webp"];

// Upper bound on resize dimensions. libvips can allocate large buffers for big
// targets — without this an LLM could request `width: 100000` and OOM the
// gateway. 8192 px covers practical use cases (8K displays, large prints) with
// headroom.
export const MAX_RESIZE_DIMENSION = 8192;

export interface CropParams {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResizeParams {
  width?: number;
  height?: number;
  fit?: ResizeFit;
}

export interface RotateParams {
  angle: number;
}

export interface ConvertParams {
  format: ConvertFormat;
}

function assertNonNegativeInt(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertPositiveInt(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export async function cropImage(input: Buffer, params: CropParams): Promise<Buffer> {
  assertNonNegativeInt("x", params.x);
  assertNonNegativeInt("y", params.y);
  assertPositiveInt("width", params.width);
  assertPositiveInt("height", params.height);

  // .rotate() with no argument auto-orients using the EXIF Orientation tag
  // before cropping — otherwise a phone photo would crop relative to the
  // unrotated sensor frame, not what the user sees.
  return sharp(input)
    .rotate()
    .extract({
      left: params.x,
      top: params.y,
      width: params.width,
      height: params.height,
    })
    .toBuffer();
}

export async function resizeImage(input: Buffer, params: ResizeParams): Promise<Buffer> {
  if (params.width === undefined && params.height === undefined) {
    throw new Error("resize requires at least one of width or height");
  }
  if (params.width !== undefined) assertPositiveInt("width", params.width);
  if (params.height !== undefined) assertPositiveInt("height", params.height);
  if (params.width !== undefined && params.width > MAX_RESIZE_DIMENSION) {
    throw new Error(`width ${params.width} exceeds maximum ${MAX_RESIZE_DIMENSION}`);
  }
  if (params.height !== undefined && params.height > MAX_RESIZE_DIMENSION) {
    throw new Error(`height ${params.height} exceeds maximum ${MAX_RESIZE_DIMENSION}`);
  }
  if (params.fit !== undefined && !ALLOWED_FITS.includes(params.fit)) {
    throw new Error(`fit must be one of: ${ALLOWED_FITS.join(", ")}`);
  }

  return sharp(input)
    .rotate()
    .resize({
      width: params.width,
      height: params.height,
      fit: params.fit ?? "inside",
      withoutEnlargement: false,
    })
    .toBuffer();
}

export async function rotateImage(input: Buffer, params: RotateParams): Promise<Buffer> {
  if (typeof params.angle !== "number" || !Number.isFinite(params.angle)) {
    throw new Error("angle must be a finite number");
  }
  // Normalise to [0, 360). sharp accepts any number but explicit normalisation
  // makes audit log values comparable.
  const normalised = ((params.angle % 360) + 360) % 360;
  return sharp(input).rotate(normalised).toBuffer();
}

export async function convertImage(input: Buffer, params: ConvertParams): Promise<Buffer> {
  if (!ALLOWED_FORMATS.includes(params.format)) {
    throw new Error(`format must be one of: ${ALLOWED_FORMATS.join(", ")}`);
  }
  const pipeline = sharp(input).rotate();
  switch (params.format) {
    case "png":
      return pipeline.png().toBuffer();
    case "jpeg":
      return pipeline.jpeg().toBuffer();
    case "webp":
      return pipeline.webp().toBuffer();
  }
}

export function extensionForFormat(format: ConvertFormat): string {
  switch (format) {
    case "png":
      return "png";
    case "jpeg":
      return "jpg";
    case "webp":
      return "webp";
  }
}
