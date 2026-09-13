// Извлечение чисел из свободного текста (условия, шёпот).
// Единственный источник: используют cli/strategy.mjs (inferLimits) и server/store.mjs (whisper).

export function extractNumbers(text) {
  return (String(text ?? '').match(/\d[\d\s]*(?:[.,]\d+)?/g) ?? [])
    .map((raw) => Number(raw.replace(/\s/g, '').replace(',', '.')))
    .filter((n) => Number.isFinite(n) && n >= 0);
}
