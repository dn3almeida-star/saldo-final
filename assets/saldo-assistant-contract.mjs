export const ASSISTANT_KINDS = ['records', 'report', 'clarification'];
export const RECORD_TYPES = ['day', 'fuel', 'expense'];
export const PLATFORMS = ['99', 'uber', 'indrive'];

const numericFields = ['ganho', 'corridas', 'km', 'horas', 'valor', 'preco', 'litros'];
const dayFields = ['ganho', 'corridas', 'km', 'horas'];

export function normalizeCurrency(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const cleaned = value.replace(/R\$\s?/gi, '').replace(/\s/g, '');
  const normalized = cleaned.includes(',')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value ? value : null;
}

export function normalizeDate(value, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const base = isoDate(today);
  if (!base) throw new Error('invalid today');
  if (value === 'hoje' || value === 'today') return base;
  if (value === 'ontem' || value === 'yesterday') {
    const date = new Date(`${base}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
  const parsed = isoDate(value);
  if (!parsed) throw new Error('invalid date');
  return parsed;
}

export function normalizePlatform(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (PLATFORMS.includes(normalized)) return normalized;
  // O motorista fala o nome comercial: "99 Pop", "Uber X", "inDriver".
  const cru = normalized.replace(/[^a-z0-9]/g, '');
  return PLATFORMS.find((plataforma) => cru.startsWith(plataforma)) ?? null;
}

// A confianca chegava em formatos variados do modelo — 0.9, "0.9", 90, ausente
// — e qualquer um fora do esperado derrubava o comando inteiro.
export function coerceConfidence(value) {
  let numero = value;
  if (typeof numero === 'string') {
    const limpo = numero.trim().replace('%', '').replace(',', '.');
    numero = limpo === '' ? NaN : Number(limpo);
  }
  if (typeof numero !== 'number' || !Number.isFinite(numero) || numero < 0) return null;
  if (numero > 1) return numero <= 100 ? numero / 100 : null;
  return numero;
}

function normalizeRecord(record, options) {
  const normalized = { type: record?.type, date: null, app: normalizePlatform(record?.app) };
  try { normalized.date = normalizeDate(record?.date, options); } catch { normalized.date = null; }
  Object.defineProperty(normalized, '_invalidPlatform', { value: record?.app != null && normalized.app === null });
  Object.defineProperty(normalized, '_missingPlatform', { value: record?.type === 'day' && record?.app == null });
  Object.defineProperty(normalized, '_invalidDate', { value: record?.date != null && normalized.date === null });
  for (const field of numericFields) {
    const value = record?.[field];
    normalized[field] = value == null || value === '' ? 0 : normalizeCurrency(value);
  }
  for (const field of ['cat', 'desc', 'obs']) normalized[field] = record?.[field] == null ? '' : String(record[field]);
  if (normalized.type === 'fuel') completarAbastecimento(normalized);
  return normalized;
}

// Erro tecnico nao serve de pergunta. "invalid ganho" vira "o ganho", que e o
// que o motorista consegue responder. Mesma tabela do servidor, de proposito:
// os dois lados tem de falar a mesma lingua com o motorista.
const NOME_DO_CAMPO = {
  date: 'a data', platform: 'a plataforma', app: 'a plataforma', ganho: 'o ganho',
  corridas: 'as corridas', km: 'os km', horas: 'as horas', valor: 'o valor',
  preco: 'o preço', litros: 'os litros', cat: 'a categoria', desc: 'a descrição',
  obs: 'a observação',
};
function comoPerguntar(erro) {
  const texto = String(erro);
  if (texto === 'unsupported record type') return 'missing o tipo do registro';
  if (texto === 'missing or invalid date' || texto === 'invalid date') return 'missing a data';
  if (texto === 'missing day value') return 'missing o ganho ou os km da corrida';
  if (texto === 'missing fuel value') return 'missing o valor do abastecimento';
  if (texto === 'missing expense value') return 'missing o valor do gasto';
  if (texto === 'missing expense category or description') return 'missing a categoria ou a descrição do gasto';
  const campo = texto.replace(/^(invalid|missing) /, '');
  return `missing ${NOME_DO_CAMPO[campo] || campo}`;
}

// Valor, preco e litros sao tres lados da mesma conta: sabendo dois, o
// terceiro nao e chute, e aritmetica. O formulario manual ja fazia isso
// (calcLitros), mas so na tela — quem registrava por voz recebia o
// abastecimento com litros zerado, e ai o km/L do app fica errado sem ninguem
// perceber.
//
// So preenche o que veio VAZIO: numero que o motorista falou nunca e
// sobrescrito. E duas casas, igual ao formulario.
function completarAbastecimento(registro) {
  const duasCasas = (n) => Number(n.toFixed(2));
  const valor = Number(registro.valor) || 0;
  const preco = Number(registro.preco) || 0;
  const litros = Number(registro.litros) || 0;
  if (!litros && valor > 0 && preco > 0) registro.litros = duasCasas(valor / preco);
  else if (!preco && valor > 0 && litros > 0) registro.preco = duasCasas(valor / litros);
  else if (!valor && preco > 0 && litros > 0) registro.valor = duasCasas(preco * litros);
  return registro;
}

function recordErrors(record) {
  const errors = [];
  if (!RECORD_TYPES.includes(record.type)) errors.push('unsupported record type');
  if (!record.date) errors.push('missing or invalid date');
  if (record._invalidDate) errors.push('invalid date');
  // Plataforma so existe em corrida. Abastecimento e despesa nao tem nenhuma,
  // e pedir uma era travar o registro por um campo que nem se aplica — o
  // servidor ja so pedia em 'day', e os dois lados tem de decidir igual.
  if (record.type === 'day' && (record._invalidPlatform || record._missingPlatform)) errors.push('missing platform');
  for (const field of numericFields) if (!Number.isFinite(record[field]) || record[field] < 0) errors.push(`invalid ${field}`);
  if (record.type === 'day' && !dayFields.some((field) => record[field] > 0) && !record.obs.trim()) errors.push('missing day value');
  if (record.type === 'fuel' && !(record.valor > 0)) errors.push('missing fuel value');
  if (record.type === 'expense' && !(record.valor > 0)) errors.push('missing expense value');
  if (record.type === 'expense' && !record.cat.trim() && !record.desc.trim()) errors.push('missing expense category or description');
  return errors;
}

export function validateAssistantCommand(command) {
  const errors = [];
  if (!command || typeof command !== 'object' || !ASSISTANT_KINDS.includes(command.kind)) return ['invalid kind'];
  if (typeof command.message !== 'string') errors.push('invalid message');
  // A confianca nao derruba o comando aqui tambem: o servidor ja converteu,
  // e nada e gravado sem o motorista tocar em Salvar.
  if (!Array.isArray(command.records)) errors.push('invalid records');
  if (!command.report || typeof command.report !== 'object') errors.push('invalid report');
  if (!Array.isArray(command.missing)) errors.push('invalid missing');
  if (command.kind === 'records') for (const record of command.records || []) errors.push(...recordErrors(record));
  // 'days' e a janela movel ("ultimos dois dias"). Periodo fora da lista o
  // servidor ja trocou por null antes de chegar aqui.
  if (command.kind === 'report' && !['day', 'week', 'month', 'all', 'custom', 'days', null].includes(command.report?.period)) errors.push('invalid report period');
  return errors;
}

const REPORT_PERIODS = ['day', 'week', 'month', 'all', 'custom', 'days', null];
const MAX_REPORT_DAYS = 90;

// A janela movel ("ultimos dois dias") so vale com a quantidade junto; sem ela
// nao quer dizer nada e vira o relatorio de hoje.
function periodoDaPergunta(report) {
  let period = REPORT_PERIODS.includes(report?.period ?? null) ? (report?.period ?? null) : null;
  let days = null;
  if (period === 'days') {
    // Number(null) e 0, nao NaN: sem este corte, "days sem quantidade" virava
    // uma janela de 1 dia por acidente em vez de cair para o relatorio de hoje.
    const bruto = report?.days;
    const pedidos = bruto === null || bruto === undefined || bruto === '' ? NaN : Number(bruto);
    days = Number.isFinite(pedidos) ? Math.min(MAX_REPORT_DAYS, Math.max(1, Math.round(pedidos))) : null;
    if (days === null) period = null;
  }
  // cat e app o servidor ja validou; aqui e so nao deixar cair no caminho,
  // senao a resposta volta a ser o relatorio geral e ignora o que foi pedido.
  return { period, date: null, cat: report?.cat ?? null, app: report?.app ?? null, days };
}

export function normalizeAssistantCommand(raw, { today } = {}) {
  let input = raw;
  if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { return { ok: false, errors: ['malformed JSON'] }; } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['command must be an object'] };
  const command = {
    kind: input.kind, message: typeof input.message === 'string' ? input.message : '',
    confidence: coerceConfidence(input.confidence) ?? 0,
    incerto: (coerceConfidence(input.confidence) ?? 0) < 0.72,
    records: Array.isArray(input.records) ? input.records.map((record) => normalizeRecord(record, { today })) : [],
    // cat e app sao os filtros da pergunta ("quanto gastei com alimentacao").
    // O servidor ja os validou; aqui e so nao deixar cair no caminho, senao a
    // resposta volta a ser o relatorio geral e ignora o que foi perguntado.
    // O periodo tambem e ajustado aqui, nao so no servidor. Os dois lados
    // precisam concordar: enquanto este recusava periodo desconhecido, a
    // pergunta morria com "nao consegui transformar esse pedido" mesmo depois
    // de o servidor ja ter resolvido o caso. Periodo que nao se conhece vira
    // hoje, e o cartao escreve "hoje" na tela — responder errado em silencio
    // seria pior do que a recusa.
    report: periodoDaPergunta(input.report),
    missing: Array.isArray(input.missing) ? [...input.missing] : [],
  };
  try { command.report.date = input.report?.date == null ? null : normalizeDate(input.report.date, { today }); } catch { command.report.date = null; }
  const errors = validateAssistantCommand(command);
  if (errors.length) {
    // Mesma regra do servidor, e os dois PRECISAM concordar: enquanto um
    // tolerava e o outro recusava, o pedido morria no aparelho depois de o
    // servidor ja ter resolvido.
    //
    // Registro com problema vira PERGUNTA, nao recusa. Recusa sobra so para o
    // que nao da para aproveitar: comando sem tipo reconhecido.
    if (command.kind === 'records') {
      command.kind = 'clarification';
      command.records = [];
      command.missing = [...new Set([...command.missing, ...errors.map(comoPerguntar)])];
      return { ok: true, command, errors: [] };
    }
    // Pergunta nunca e recusada: ela e so leitura. No pior caso o relatorio
    // sai do dia de hoje, e o cartao escreve "hoje" na tela.
    if (command.kind === 'report') return { ok: true, command, errors: [] };
    return { ok: false, errors };
  }
  return { ok: true, command, errors: [] };
}

export function toLocalRecord(record, { idFactory = () => crypto.randomUUID() } = {}) {
  const id = idFactory();
  if (record.type === 'day') return { id, data: record.date, app: record.app, ganho: record.ganho, corridas: record.corridas, km: record.km, horas: record.horas, obs: record.obs };
  if (record.type === 'fuel') return { id, data: record.date, valor: record.valor, preco: record.preco, litros: record.litros };
  if (record.type === 'expense') return { id, data: record.date, cat: record.cat, valor: record.valor, desc: record.desc };
  throw new Error('unsupported record type');
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
export function buildRecordPreview(command) { return `${escapeHtml(command.message || '')}\n${(command.records || []).map((record) => `${escapeHtml(record.date)} ${escapeHtml(record.app || record.cat || record.type)} ${escapeHtml(record.valor || record.ganho || '')} ${escapeHtml(record.desc || record.obs || '')}`).join('\n')}`; }
// "missing" e marcador interno dos dois contratos, nao palavra para o
// motorista ler. Chegou na tela como "Informe os dados faltantes: missing a
// data". Tirar aqui, na hora de escrever, conserta todos os casos de uma vez —
// e os marcadores continuam valendo por dentro.
export function buildClarification(command) { return `Informe os dados faltantes: ${(command.missing || []).map((item) => escapeHtml(String(item).replace(/^missing\s+/i, ''))).join(', ')}`; }
