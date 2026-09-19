export const ENTITY_NAMES = Object.freeze(['days', 'fuel', 'exp', 'goals']);

export const TABLES = Object.freeze({
  days: 'daily_records',
  fuel: 'fuelings',
  exp: 'expenses',
  goals: 'goals',
});

export const DEFAULT_VEHICLE = Object.freeze({
  make: 'Chevrolet',
  model: 'Prisma',
  version: '1.4 MT LT',
  modelYear: 2015,
  color: 'Prata',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return template.replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0;
    const value = char === 'x' ? random : (random & 0x3 | 0x8);
    return value.toString(16);
  });
}

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toCents(value) {
  return Math.round(toNumber(value) * 100);
}

export function fromCents(value) {
  return toNumber(value) / 100;
}

export function normalizePlatform(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'uber') return 'uber';
  if (normalized === 'indrive' || normalized === 'in drive' || normalized === 'in_drive') return 'indrive';
  return '99';
}

// Id estavel derivado do id antigo do aparelho. Antes sorteavamos um id novo a
// cada importacao, entao importar de novo (outro endereco, outro aparelho, cache
// limpo) criava LINHAS NOVAS em vez de reescrever as mesmas — a conta ganhava
// registros que o motorista nunca lancou. Mesmo id antigo, mesmo id: a segunda
// importacao vira uma reescrita inofensiva.
function idFromLegacy(legacyId) {
  let hash = 2166136261;
  const bytes = [];
  for (let round = 0; round < 4; round += 1) {
    const seed = `${round}:${legacyId}`;
    hash = 2166136261;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const unsigned = hash >>> 0;
    bytes.push(unsigned.toString(16).padStart(8, '0'));
  }
  const hex = bytes.join('');
  // Formato uuid v5 (o "5" e o "8" marcam id derivado de nome, nao sorteado).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeCommon(source, { userId = null, vehicleId = null, idFactory = createId, now = new Date().toISOString() } = {}) {
  const rawId = source?.id ?? null;
  const legacyId = source?.legacyId ?? source?.legacy_id ?? (rawId && !isUuid(rawId) ? rawId : null);
  const id = isUuid(rawId) ? rawId : (legacyId ? idFromLegacy(legacyId) : idFactory());
  return {
    id,
    ownerId: userId,
    vehicleId,
    updatedAt: source?.updatedAt ?? source?.updated_at ?? now,
    deletedAt: source?.deletedAt ?? source?.deleted_at ?? null,
    legacyId,
  };
}

// Data do usuario: local, nunca UTC (toISOString vira o dia seguinte depois das 21h no Brasil).
// Tambem corta a hora que o servidor as vezes manda junto ("2026-09-17T00:00:00+00:00").
function normalizeDate(value) {
  if (value) return String(value).slice(0, 10);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function normalizeDay(source, options, overrides = {}) {
  const common = normalizeCommon(source, options);
  return {
    ...common,
    data: normalizeDate(source?.data ?? source?.record_date),
    app: normalizePlatform(source?.app ?? source?.platform),
    ganho: Math.max(0, toNumber(source?.ganho ?? fromCents(source?.gross_income_cents))),
    corridas: Math.max(0, Math.round(toNumber(source?.corridas ?? source?.ride_count))),
    km: Math.max(0, toNumber(source?.km ?? source?.distance_km)),
    horas: Math.max(0, toNumber(source?.horas ?? source?.worked_hours)),
    obs: String(source?.obs ?? source?.notes ?? ''),
    ...overrides,
  };
}

function normalizeFuel(source, options) {
  const common = normalizeCommon(source, options);
  return {
    ...common,
    data: normalizeDate(source?.data ?? source?.fuel_date),
    valor: Math.max(0, toNumber(source?.valor ?? fromCents(source?.amount_cents))),
    preco: Math.max(0, toNumber(source?.preco ?? fromCents(source?.price_per_liter_cents))),
    litros: Math.max(0, toNumber(source?.litros)),
  };
}

function normalizeExpense(source, options) {
  const common = normalizeCommon(source, options);
  return {
    ...common,
    data: normalizeDate(source?.data ?? source?.expense_date),
    cat: String(source?.cat ?? source?.category ?? 'Outros'),
    valor: Math.max(0, toNumber(source?.valor ?? fromCents(source?.amount_cents))),
    desc: String(source?.desc ?? source?.description ?? ''),
  };
}

export function normalizeLegacyState(input = {}, options = {}) {
  const days = [];
  for (const source of Array.isArray(input.days) ? input.days : []) {
    const hasLegacyPlatforms = source && !source.app && (source.g99 !== undefined || source.gin !== undefined);
    if (!hasLegacyPlatforms) {
      days.push(normalizeDay(source, options));
      continue;
    }
    const apps = [
      ['99', toNumber(source.g99)],
      ['indrive', toNumber(source.gin)],
    ].filter(([, value]) => value > 0);
    if (!apps.length) apps.push(['99', 0]);
    const totalCorridas = Math.max(0, toNumber(source.corridas));
    apps.forEach(([app, ganho], index) => {
      const legacyId = source.id ? `${source.id}:${app}` : null;
      const normalized = normalizeDay(source, options, {
        id: index === 0 && isUuid(source.id)
          ? source.id
          : (legacyId ? idFromLegacy(legacyId) : (options.idFactory ?? createId)()),
        legacyId,
        app,
        ganho,
        // O registro antigo guardava os dois apps numa linha so, com UMA contagem
        // de corridas. Copiar o total para as duas linhas dobrava a contagem —
        // fica tudo na primeira, que e a unica que tambem herda km e horas.
        corridas: index === 0 ? totalCorridas : 0,
        km: index === 0 ? Math.max(0, toNumber(source.km)) : 0,
        horas: index === 0 ? Math.max(0, toNumber(source.horas)) : 0,
      });
      days.push(normalized);
    });
  }

  const fuel = (Array.isArray(input.fuel) ? input.fuel : []).map((source) => normalizeFuel(source, options));
  const exp = (Array.isArray(input.exp) ? input.exp : []).map((source) => normalizeExpense(source, options));
  const settings = {
    metaDiaria: Math.max(0, toNumber(input.settings?.metaDiaria)),
    metaSemanal: Math.max(0, toNumber(input.settings?.metaSemanal)),
    metaMensal: Math.max(0, toNumber(input.settings?.metaMensal)),
  };
  // Uma meta por periodo, independentes. Meta zerada nao vira registro.
  const goals = [['metaDiaria', 'day'], ['metaSemanal', 'week'], ['metaMensal', 'month']]
    .filter(([campo]) => settings[campo] > 0)
    .map(([campo, periodo], indice) => ({
      id: (indice === 0 && options.goalId) ? options.goalId : (options.idFactory ?? createId)(),
      ownerId: options.userId ?? null,
      vehicleId: options.vehicleId ?? null,
      periodType: periodo,
      targetCents: toCents(settings[campo]),
      active: true,
      updatedAt: options.now ?? new Date().toISOString(),
      deletedAt: null,
      legacyId: `rc_settings:${campo}`,
    }));

  return {
    days,
    fuel,
    exp,
    goals,
    settings,
  };
}

function remoteCommon(entity, record, { userId = null, vehicleId = null, now = new Date().toISOString() } = {}) {
  return {
    id: record.id,
    user_id: userId ?? record.ownerId ?? null,
    vehicle_id: vehicleId ?? record.vehicleId ?? null,
    legacy_id: record.legacyId ?? record.legacy_id ?? null,
    updated_at: record.updatedAt ?? record.updated_at ?? now,
    deleted_at: record.deletedAt ?? record.deleted_at ?? null,
  };
}

export function localToRemote(entity, record, options = {}) {
  const common = remoteCommon(entity, record, options);
  if (entity === 'days') {
    return {
      ...common,
      record_date: record.data,
      platform: normalizePlatform(record.app),
      gross_income_cents: Math.max(0, Number.isInteger(record.ganhoCents) ? record.ganhoCents : toCents(record.ganho)),
      ride_count: Math.max(0, Math.round(toNumber(record.corridas))),
      distance_km: Math.max(0, toNumber(record.km)),
      worked_hours: Math.max(0, toNumber(record.horas)),
      notes: String(record.obs ?? ''),
    };
  }
  if (entity === 'fuel') {
    return {
      ...common,
      fuel_date: record.data,
      amount_cents: Math.max(0, Number.isInteger(record.valorCents) ? record.valorCents : toCents(record.valor)),
      price_per_liter_cents: Math.max(0, Number.isInteger(record.precoCents) ? record.precoCents : toCents(record.preco)),
      liters: Math.max(0, toNumber(record.litros)),
    };
  }
  if (entity === 'exp') {
    return {
      ...common,
      expense_date: record.data,
      category: String(record.cat ?? 'Outros'),
      amount_cents: Math.max(0, Number.isInteger(record.valorCents) ? record.valorCents : toCents(record.valor)),
      description: String(record.desc ?? ''),
    };
  }
  if (entity === 'goals') {
    return {
      ...common,
      period_type: record.periodType ?? record.period_type ?? 'day',
      target_cents: Math.max(0, Number.isInteger(record.targetCents) ? record.targetCents : toCents(record.target)),
      active: record.active !== false,
    };
  }
  throw new Error(`Entidade desconhecida: ${entity}`);
}

export function fromRemoteRecord(entity, record) {
  const common = {
    id: record.id,
    ownerId: record.user_id ?? null,
    vehicleId: record.vehicle_id ?? null,
    updatedAt: record.updated_at ?? null,
    deletedAt: record.deleted_at ?? null,
    legacyId: record.legacy_id ?? null,
  };
  if (entity === 'days') return {
    ...common,
    data: record.record_date,
    app: normalizePlatform(record.platform),
    ganho: fromCents(record.gross_income_cents),
    corridas: Math.max(0, Number(record.ride_count ?? 0)),
    km: Math.max(0, Number(record.distance_km ?? 0)),
    horas: Math.max(0, Number(record.worked_hours ?? 0)),
    obs: String(record.notes ?? ''),
  };
  if (entity === 'fuel') return {
    ...common,
    data: record.fuel_date,
    valor: fromCents(record.amount_cents),
    preco: fromCents(record.price_per_liter_cents),
    litros: Math.max(0, Number(record.liters ?? 0)),
  };
  if (entity === 'exp') return {
    ...common,
    data: record.expense_date,
    cat: String(record.category ?? 'Outros'),
    valor: fromCents(record.amount_cents),
    desc: String(record.description ?? ''),
  };
  if (entity === 'goals') return {
    ...common,
    periodType: record.period_type ?? 'day',
    targetCents: Math.max(0, Number(record.target_cents ?? 0)),
    active: record.active !== false,
  };
  throw new Error(`Entidade desconhecida: ${entity}`);
}

export function makeOutboxId(entity, recordId) {
  return `${entity}:${recordId}`;
}
