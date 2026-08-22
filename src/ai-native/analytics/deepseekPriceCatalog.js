export const DEEPSEEK_PRICE_SOURCE = Object.freeze({
  provider: "deepseek",
  pricing_page: "https://api-docs.deepseek.com/quick_start/pricing/",
  verified_at: "2026-08-19",
  model: "deepseek-v4-flash",
  provider_model_version: "DeepSeek-V4-Flash-0731",
  unit: "USD per 1M tokens",
  peak_hours_utc: Object.freeze([
    Object.freeze({ start_hour: 1, end_hour: 4 }),
    Object.freeze({ start_hour: 6, end_hour: 10 }),
  ]),
});

const RATE_WINDOWS = Object.freeze({
  off_peak: Object.freeze({
    catalog_version: "deepseek-v4-flash-2026-08-19-off-peak-v1",
    currency: "USD",
    models: Object.freeze({
      "deepseek-v4-flash": Object.freeze({
        input_microunits_per_million: 220_000,
        cached_input_microunits_per_million: 7_000,
        output_microunits_per_million: 660_000,
      }),
    }),
  }),
  peak: Object.freeze({
    catalog_version: "deepseek-v4-flash-2026-08-19-peak-v1",
    currency: "USD",
    models: Object.freeze({
      "deepseek-v4-flash": Object.freeze({
        input_microunits_per_million: 440_000,
        cached_input_microunits_per_million: 14_000,
        output_microunits_per_million: 1_320_000,
      }),
    }),
  }),
});

function utcHour(isoTimestamp) {
  if (typeof isoTimestamp !== "string") throw new Error("DEEPSEEK_PRICE_TIMESTAMP_INVALID");
  const timestamp = new Date(isoTimestamp);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("DEEPSEEK_PRICE_TIMESTAMP_INVALID");
  return timestamp.getUTCHours();
}

export function deepSeekRateWindowAt(isoTimestamp) {
  const hour = utcHour(isoTimestamp);
  return DEEPSEEK_PRICE_SOURCE.peak_hours_utc.some(
    ({ start_hour: start, end_hour: end }) => hour >= start && hour < end,
  ) ? "peak" : "off_peak";
}

export function deepSeekPriceCatalogAt(isoTimestamp) {
  return RATE_WINDOWS[deepSeekRateWindowAt(isoTimestamp)];
}

export function deepSeekPriceCatalogForEvents(events) {
  if (!Array.isArray(events)) throw new Error("DEEPSEEK_PRICE_EVENTS_INVALID");
  const usageEvents = events.filter((event) => event?.event_name === "model_usage_observed");
  if (usageEvents.length === 0) throw new Error("DEEPSEEK_PRICE_USAGE_EVENTS_REQUIRED");
  const windows = new Set(usageEvents.map((event) => deepSeekRateWindowAt(event.server_at)));
  if (windows.size !== 1) throw new Error("DEEPSEEK_PRICE_WINDOW_MIXED");
  return RATE_WINDOWS[[...windows][0]];
}
