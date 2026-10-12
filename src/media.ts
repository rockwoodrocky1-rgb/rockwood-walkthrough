import { LIMITS, type Photo } from "../shared/model";
function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("This image could not be encoded.")),
      "image/jpeg",
      quality,
    ),
  );
}
export async function imageBlobs(
  source: CanvasImageSource,
  width: number,
  height: number,
) {
  if (!width || !height)
    throw new Error(
      "Camera is not ready. Wait for the live image, then try again.",
    );
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1920 / Math.max(width, height));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Photo capture is not supported in this browser.");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await encode(canvas, 0.88);
  let edge: number = LIMITS.imageEdge;
  for (let attempt = 0; attempt < 5; attempt++) {
    const small = document.createElement("canvas");
    const factor = Math.min(1, edge / Math.max(width, height));
    small.width = Math.round(width * factor);
    small.height = Math.round(height * factor);
    small.getContext("2d")!.drawImage(source, 0, 0, small.width, small.height);
    const modelBlob = await encode(
      small,
      Math.max(0.45, 0.78 - attempt * 0.07),
    );
    if (modelBlob.size <= LIMITS.imageTargetBytes) return { blob, modelBlob };
    edge = Math.floor(edge * 0.82);
  }
  throw new Error(
    "This image is too large to prepare for the report. Try a smaller photo.",
  );
}
export async function importPhoto(
  file: File,
  meta: Omit<Photo, "blob" | "modelBlob">,
): Promise<Photo> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error(
      "Use JPEG, PNG, or WebP. HEIC is not supported; export it as JPEG first.",
    );
  if (file.size > LIMITS.uploadBytes)
    throw new Error("Choose an image smaller than 15 MB.");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      ...meta,
      ...(await imageBlobs(img, img.naturalWidth, img.naturalHeight)),
    };
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Could not import photo: ${error.message}`
        : "Image could not be decoded.",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(blob);
  });
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
