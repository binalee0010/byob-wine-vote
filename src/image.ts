async function decodePhoto(file: File) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch { /* Older Safari may expose this API without supporting the requested image. */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = url;
    });
    if (typeof image.decode === 'function') await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Invalid image size');
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('사진을 읽을 수 없습니다. JPEG 또는 PNG로 변환해 주세요.');
  }
}

export async function preparePhoto(file: File): Promise<File> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error(/hei[cf]/i.test(file.type + file.name) ? 'HEIC 사진은 JPEG 또는 PNG로 변환한 뒤 올려 주세요.' : 'JPEG, PNG, WebP 사진만 올릴 수 있습니다.');
  }
  if (file.size > 40 * 1024 * 1024) throw new Error('원본 사진은 40MB 이하로 선택해 주세요.');
  const image = await decodePhoto(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('사진을 처리할 수 없습니다. 다른 브라우저에서 다시 시도해 주세요.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null = null;
    for (const quality of [0.86, 0.72, 0.58, 0.42]) {
      blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= 2 * 1024 * 1024) break;
    }
    if (!blob || blob.size > 2 * 1024 * 1024) throw new Error('사진 용량을 줄이지 못했습니다. 더 작은 사진을 선택해 주세요.');
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally { image.release(); }
}
