import { createId, normalizeLegacyState } from './saldo-backend-model.mjs';

function hash16(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  const second = Math.imul(unsigned ^ 0x9e3779b9, 2246822519) >>> 0;
  return `${unsigned.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

export function hasLegacyData(state = {}) {
  return Boolean(
    (Array.isArray(state.days) && state.days.length) ||
    (Array.isArray(state.fuel) && state.fuel.length) ||
    (Array.isArray(state.exp) && state.exp.length) ||
    Number(state.settings?.metaDiaria) > 0,
  );
}

export function legacyFingerprint(state = {}) {
  return hash16(JSON.stringify({
    days: state.days ?? [],
    fuel: state.fuel ?? [],
    exp: state.exp ?? [],
    settings: state.settings ?? {},
  }));
}

export function buildLegacyImport({
  days = [], fuel = [], exp = [], settings = {}, userId = null, vehicleId = null, idFactory = createId,
} = {}) {
  const source = { days, fuel, exp, settings };
  const normalized = normalizeLegacyState(source, { userId, vehicleId, idFactory });
  return {
    ...normalized,
    fingerprint: legacyFingerprint(source),
    source: 'localStorage',
    importedAt: new Date().toISOString(),
  };
}
