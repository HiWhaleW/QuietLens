const preloadRecords = new Map();

function browserImageFactory() {
  if (typeof Image !== "function") throw new Error("Image is unavailable in this runtime");
  return new Image();
}

export function getDecodedImageStatus(url) {
  return preloadRecords.get(url)?.status ?? "idle";
}

export function preloadDecodedImage(url, { fetchPriority = "low", imageFactory = browserImageFactory } = {}) {
  if (!url) return Promise.reject(new Error("A media URL is required"));
  const existing = preloadRecords.get(url);
  if (existing) return existing.promise;

  const image = imageFactory();
  image.decoding = "async";
  image.fetchPriority = fetchPriority;

  const record = { status: "loading", image, promise: null };
  record.promise = new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", () => reject(new Error(`Failed to load media: ${url}`)), { once: true });
    image.src = url;
  })
    .then(async () => {
      if (typeof image.decode === "function") await image.decode();
      record.status = "ready";
      return image;
    })
    .catch((error) => {
      record.status = "failed";
      throw error;
    });
  preloadRecords.set(url, record);
  return record.promise;
}

export function resetMediaPrefetchesForTests() {
  preloadRecords.clear();
}
