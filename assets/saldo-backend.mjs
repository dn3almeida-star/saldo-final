import {
  DEFAULT_VEHICLE,
  ENTITY_NAMES,
  createId,
  fromRemoteRecord,
  localToRemote,
  normalizeLegacyState,
} from './saldo-backend-model.mjs';
import { buildLegacyImport, hasLegacyData } from './saldo-migration.mjs';
import { createIndexedDbStore } from './saldo-local-store.mjs';
import { createSupabaseRemote } from './saldo-supabase.mjs';
import { createAuthService } from './saldo-auth.mjs';
import { createSyncEngine } from './saldo-sync.mjs';

const LEGACY_KEYS = Object.freeze({ days: 'rc_days', fuel: 'rc_fuel', exp: 'rc_exp', settings: 'rc_settings' });
const KEY_TO_ENTITY = Object.freeze({ rc_days: 'days', rc_fuel: 'fuel', rc_exp: 'exp' });

function parseJson(storage, key, fallback) {
  try {
    const parsed = JSON.parse(storage?.getItem(key) ?? '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isOnline(windowRef) {
  return windowRef.navigator?.onLine !== false;
}

function dispatch(windowRef, name, detail) {
  if (typeof windowRef.dispatchEvent !== 'function' || typeof windowRef.CustomEvent !== 'function') return;
  windowRef.dispatchEvent(new windowRef.CustomEvent(name, { detail }));
}

export function createBackend({
  windowRef = globalThis,
  DB,
  storage = windowRef.localStorage,
  client = null,
  config = windowRef.SALDO_FINAL_CONFIG,
  store = null,
  now = () => new Date().toISOString(),
  confirmImport = (message) => windowRef.confirm?.(message) ?? true,
} = {}) {
  if (!DB) throw new Error('O backend precisa receber o estado DB do app');

  const localStore = store ?? createIndexedDbStore({ dbName: 'saldo-final-local-v1' });
  let supabaseClient = client;
  let remote = null;
  let auth = null;
  let sync = null;
  let currentUser = null;
  let currentSession = null;
  let vehicle = null;
  let initialized = false;
  let authReady = false;
  let hydrating = false;
  let writeChain = Promise.resolve();
  let unsubscribeAuth = null;
  let syncChain = Promise.resolve();
  let currentStatus = 'local';

  function ownerKey() {
    return currentUser?.id ?? 'local';
  }

  function settingsKey() {
    return `settings:${ownerKey()}`;
  }

  function status(statusName, message = '') {
    currentStatus = statusName;
    dispatch(windowRef, 'saldo-backend-status', {
      status: statusName,
      message,
      userId: currentUser?.id ?? null,
      vehicleId: vehicle?.id ?? null,
    });
    const indicator = windowRef.document?.querySelector?.('[data-backend-status]');
    if (indicator) {
      indicator.dataset.state = statusName;
      indicator.textContent = message || ({
        local: 'Somente neste aparelho',
        offline: 'Offline · salvo neste aparelho',
        syncing: 'Sincronizando…',
        synced: 'Sincronizado',
        authenticated: 'Conta conectada',
        conflict: 'Conflito para revisar',
        error: 'Sincronização pendente',
      }[statusName] ?? statusName);
    }
  }

  function notify(message) {
    if (typeof windowRef.SaldoFinalToast === 'function') windowRef.SaldoFinalToast(message);
    else if (typeof windowRef.toast === 'function') windowRef.toast(message);
  }

  function renderAuthUi() {
    windowRef.SaldoFinalAuthUi?.render?.();
  }

  function readLegacyState() {
    return {
      days: parseJson(storage, LEGACY_KEYS.days, clone(DB.days ?? [])),
      fuel: parseJson(storage, LEGACY_KEYS.fuel, clone(DB.fuel ?? [])),
      exp: parseJson(storage, LEGACY_KEYS.exp, clone(DB.exp ?? [])),
      settings: parseJson(storage, LEGACY_KEYS.settings, clone(DB.settings ?? { metaDiaria: 0 })),
    };
  }

  function visibleToCurrentUser(record) {
    if (currentUser) return record?.ownerId === currentUser.id;
    return !record?.ownerId;
  }

  async function readLocalState() {
    const [days, fuel, exp, goals, storedSettings] = await Promise.all([
      localStore.list('days'),
      localStore.list('fuel'),
      localStore.list('exp'),
      localStore.list('goals'),
      localStore.getMeta(settingsKey(), null),
    ]);
    const active = (records) => records.filter((record) => visibleToCurrentUser(record) && !record.deletedAt);
    DB.days = active(days);
    DB.fuel = active(fuel);
    DB.exp = active(exp);
    // Zero guardado neste aparelho NAO e uma escolha, e ausencia de escolha: com
    // "??" o zero vencia a meta que estava no servidor e a meta do motorista
    // sumia sozinha depois de entrar na conta. So um valor maior que zero manda.
    const metaDe = (periodo) => {
      const goal = goals.find((g) => visibleToCurrentUser(g) && g.periodType === periodo && !g.deletedAt && g.active !== false);
      return goal ? Number(goal.targetCents ?? 0) / 100 : 0;
    };
    const guardada = (campo) => Math.max(0, Number(storedSettings?.[campo] ?? 0));
    DB.settings = {
      metaDiaria: guardada('metaDiaria') || metaDe('day'),
      metaSemanal: guardada('metaSemanal') || metaDe('week'),
      metaMensal: guardada('metaMensal') || metaDe('month'),
    };
    return { days: DB.days, fuel: DB.fuel, exp: DB.exp, settings: DB.settings };
  }

  async function mirrorState(state, { ownerId = currentUser?.id ?? null, vehicleId = vehicle?.id ?? null, queue = Boolean(currentUser) } = {}) {
    const normalized = normalizeLegacyState(state, { userId: ownerId, vehicleId, now: now(), idFactory: createId });
    DB.days = normalized.days;
    DB.fuel = normalized.fuel;
    DB.exp = normalized.exp;
    DB.settings = normalized.settings;
    await localStore.putMany('days', normalized.days);
    await localStore.putMany('fuel', normalized.fuel);
    await localStore.putMany('exp', normalized.exp);
    await localStore.putMany('goals', normalized.goals);
    await localStore.setMeta(settingsKey(), normalized.settings);
    if (queue && sync) {
      for (const entity of ENTITY_NAMES) {
        for (const record of normalized[entity]) await sync.enqueueUpsert(entity, record);
      }
    }
    return normalized;
  }

  async function ensureClient() {
    if (supabaseClient) return supabaseClient;
    const api = windowRef.supabase;
    if (!config?.url || !config?.publishableKey || typeof api?.createClient !== 'function') return null;
    supabaseClient = api.createClient(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    return supabaseClient;
  }

  async function ensureVehicle(userId) {
    const existing = await remote.getVehicle(userId);
    if (existing?.error) throw existing.error;
    if (existing?.data) {
      vehicle = existing.data;
      await localStore.put('vehicles', existing.data);
      return vehicle;
    }
    const created = await remote.upsertVehicle({
      id: createId(),
      user_id: userId,
      make: DEFAULT_VEHICLE.make,
      model: DEFAULT_VEHICLE.model,
      version: DEFAULT_VEHICLE.version,
      model_year: DEFAULT_VEHICLE.modelYear,
      color: DEFAULT_VEHICLE.color,
      plate: null,
      deleted_at: null,
    });
    if (created?.error) throw created.error;
    vehicle = created.data ?? { ...DEFAULT_VEHICLE, id: createId(), user_id: userId };
    await localStore.put('vehicles', vehicle);
    return vehicle;
  }

  async function importLegacyForUser() {
    const legacy = readLegacyState();
    if (!hasLegacyData(legacy)) return false;
    const markerKey = `legacy-import:${currentUser.id}`;
    if (await localStore.getMeta(markerKey, null)) return false;
    const accepted = confirmImport('Encontramos dados salvos neste aparelho. Deseja importar esses registros para sua conta do Saldo Final?');
    if (!accepted) {
      await localStore.setMeta(markerKey, { status: 'skipped', at: now() });
      return false;
    }
    const imported = buildLegacyImport({
      ...legacy,
      userId: currentUser.id,
      vehicleId: vehicle.id,
      idFactory: createId,
    });
    hydrating = true;
    try {
      await mirrorState(imported, { ownerId: currentUser.id, vehicleId: vehicle.id, queue: false });
      for (const entity of ENTITY_NAMES) {
        for (const record of imported[entity]) await sync.enqueueUpsert(entity, record);
      }
      await localStore.setMeta(markerKey, { status: 'imported', fingerprint: imported.fingerprint, at: now() });
      notify('Dados antigos importados para sua conta');
      return true;
    } finally {
      hydrating = false;
    }
  }

  async function activateSession(session) {
    if (!session?.user) return deactivateSession();
    if (currentUser?.id === session.user.id && sync) {
      renderAuthUi();
      return;
    }
    currentSession = session;
    currentUser = session.user;
    status('syncing', 'Conectando sua conta…');
    try {
      await remote.upsertProfile({
        id: currentUser.id,
        full_name: currentUser.user_metadata?.full_name ?? currentUser.email ?? null,
      });
      await ensureVehicle(currentUser.id);
      sync = createSyncEngine({
        store: localStore,
        remote,
        entities: ENTITY_NAMES,
        userId: currentUser.id,
        vehicleId: vehicle.id,
        serialize: (entity, record, options) => localToRemote(entity, record, {
          userId: currentUser.id,
          vehicleId: vehicle.id,
          now: options.now,
        }),
        deserialize: (entity, record) => fromRemoteRecord(entity, record),
        now,
      });
      await importLegacyForUser();
      await syncNow({ quiet: true });
      await readLocalState();
      if (isOnline(windowRef) && currentStatus === 'synced') status('authenticated', 'Conta conectada');
      else if (!isOnline(windowRef)) status('offline', 'Offline · salvo neste aparelho');
      windowRef.SaldoFinalRenderAll?.();
      renderAuthUi();
    } catch (error) {
      status('error', 'Conta conectada · sincronização pendente');
      notify(`Não foi possível sincronizar agora: ${error.message ?? error}`);
      await readLocalState();
      windowRef.SaldoFinalRenderAll?.();
      renderAuthUi();
    }
  }

  async function deactivateSession() {
    sync?.stop?.();
    sync = null;
    currentUser = null;
    currentSession = null;
    vehicle = null;
    await readLocalState();
    status('local', 'Somente neste aparelho');
    windowRef.SaldoFinalRenderAll?.();
    renderAuthUi();
  }

  async function syncNow({ quiet = false } = {}) {
    if (!sync || !currentUser || !isOnline(windowRef)) {
      if (!isOnline(windowRef)) status('offline', 'Offline · salvo neste aparelho');
      return null;
    }
    syncChain = syncChain.then(async () => {
      if (!quiet) status('syncing', 'Sincronizando…');
      const result = await sync.sync();
      await readLocalState();
      const hasErrors = result.pushed.failed || result.pulled.errors;
      const hasConflicts = result.pulled.conflicts > 0;
      status(
        hasErrors ? 'error' : (hasConflicts ? 'conflict' : 'synced'),
        hasErrors ? 'Sincronização pendente' : (hasConflicts ? 'Conflito para revisar' : 'Sincronizado'),
      );
      dispatch(windowRef, 'saldo-backend-sync', result);
      windowRef.SaldoFinalRenderAll?.();
      return result;
    });
    return syncChain;
  }

  async function listConflicts({ openOnly = false } = {}) {
    const conflicts = sync ? await sync.listConflicts({ status: openOnly ? 'open' : null }) : await localStore.listConflicts();
    return conflicts.filter((conflict) => currentUser ? conflict.ownerId === currentUser.id : !conflict.ownerId);
  }

  async function resolveConflict(conflictId, resolution) {
    if (!sync || !currentUser) throw new Error('Entre na conta para resolver conflitos');
    const resolved = await sync.resolveConflict(conflictId, resolution);
    await readLocalState();
    if (isOnline(windowRef)) await syncNow({ quiet: true });
    dispatch(windowRef, 'saldo-backend-conflicts', await listConflicts({ openOnly: true }));
    windowRef.SaldoFinalRenderAll?.();
    return resolved;
  }

  function onLegacyStateChanged(key, value) {
    if (!initialized || hydrating) return Promise.resolve();
    writeChain = writeChain.then(async () => {
      if (key === 'rc_settings') {
        const settings = clone(value) ?? {};
        await localStore.setMeta(settingsKey(), settings);
        const existentes = await localStore.list('goals');
        // Uma meta por periodo, independentes entre si.
        for (const [campo, periodo] of [['metaDiaria', 'day'], ['metaSemanal', 'week'], ['metaMensal', 'month']]) {
          const alvo = Math.max(0, Number(settings[campo] ?? 0));
          const previous = existentes.find((g) => visibleToCurrentUser(g) && g.periodType === periodo);
          const goal = {
            id: previous?.id ?? createId(),
            ownerId: currentUser?.id ?? null,
            vehicleId: vehicle?.id ?? null,
            periodType: periodo,
            targetCents: Math.round(alvo * 100),
            active: alvo > 0,
            updatedAt: now(),
            deletedAt: alvo > 0 ? null : now(),
            legacyId: `rc_settings:${campo}`,
          };
          await localStore.put('goals', goal);
          if (sync && currentUser) await sync.enqueueUpsert('goals', goal);
        }
        return;
      }
      const entity = KEY_TO_ENTITY[key];
      if (!entity) return;
      const normalized = normalizeLegacyState({ [entity]: value }, {
        userId: currentUser?.id ?? null,
        vehicleId: vehicle?.id ?? null,
        now: now(),
        idFactory: createId,
      })[entity];
      await localStore.putMany(entity, normalized);
      if (sync && currentUser) for (const record of normalized) await sync.enqueueUpsert(entity, record);
    });
    return writeChain;
  }

  function recordDeleted(kind, id) {
    if (!ENTITY_NAMES.includes(kind)) return Promise.resolve();
    writeChain = writeChain.then(async () => {
      if (!currentUser || !sync) {
        await localStore.delete(kind, id);
        return;
      }
      const tombstone = {
        id,
        ownerId: currentUser.id,
        vehicleId: vehicle.id,
        updatedAt: now(),
        deletedAt: now(),
      };
      await localStore.put(kind, tombstone);
      await sync.enqueueDelete(kind, tombstone);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return api();
    await localStore.init();
    const resolvedClient = await ensureClient();
    if (!resolvedClient) {
      await mirrorState(readLegacyState(), { ownerId: null, vehicleId: null, queue: false });
      await readLocalState();
      initialized = true;
      authReady = true;
      status('local', 'Somente neste aparelho');
      renderAuthUi();
      return api();
    }
    remote = createSupabaseRemote({ client: resolvedClient });
    auth = createAuthService({ client: resolvedClient });
    unsubscribeAuth = auth.onChange((_event, session) => {
      queueMicrotask(() => session ? activateSession(session) : deactivateSession());
    });
    const sessionResult = await auth.getSession();
    initialized = true;
    if (sessionResult?.error) status('error', 'Não foi possível ler a sessão');
    if (sessionResult?.data?.session) {
      const activation = activateSession(sessionResult.data.session);
      authReady = true;
      renderAuthUi();
      await activation;
    }
    else {
      authReady = true;
      renderAuthUi();
      await mirrorState(readLegacyState(), { ownerId: null, vehicleId: null, queue: false });
      await readLocalState();
      status('local', 'Entre para sincronizar seus dados');
      windowRef.SaldoFinalRenderAll?.();
    }
    windowRef.addEventListener?.('online', () => syncNow());
    windowRef.addEventListener?.('offline', () => status('offline', 'Offline · salvo neste aparelho'));
    return api();
  }

  async function signIn(email, password) {
    if (!auth) throw new Error('O Supabase Auth ainda não está disponível');
    const result = await auth.signIn({ email, password });
    if (result.error) throw result.error;
    return result;
  }

  async function signUp(email, password, fullName) {
    if (!auth) throw new Error('O Supabase Auth ainda não está disponível');
    const result = await auth.signUp({ email, password, fullName });
    if (result.error) throw result.error;
    return result;
  }

  // Endereco para onde o Google (ou o e-mail de senha) devolve o usuario: o mesmo
  // que ele esta vendo agora, inteiro. Montar so origin+pathname jogava fora o "?v="
  // que fura o cache do celular — a volta reabria a copia velha da pagina e os
  // botoes novos "sumiam" depois do login.
  function enderecoDeVolta() {
    const loc = windowRef.location;
    if (!loc) return undefined;
    if (loc.href) return String(loc.href).split('#')[0];
    return `${loc.origin}${loc.pathname}`;
  }

  async function signInWithGoogle() {
    if (!auth) throw new Error('O Supabase Auth ainda não está disponível');
    const result = await auth.signInWithGoogle({ redirectTo: enderecoDeVolta() });
    if (result.error) throw result.error;
    return result;
  }

  async function signOut() {
    if (!auth) return deactivateSession();
    const result = await auth.signOut();
    if (result.error) throw result.error;
    await deactivateSession();
  }

  async function resetPassword(email) {
    if (!auth) throw new Error('O Supabase Auth ainda não está disponível');
    const result = await auth.resetPassword(email, enderecoDeVolta());
    if (result.error) throw result.error;
    return result;
  }

  function openAuth() {
    const modal = windowRef.document?.getElementById('authModal');
    if (modal) modal.classList.add('show');
    windowRef.SaldoFinalAuthUi?.render?.();
  }

  function closeAuth() {
    windowRef.document?.getElementById('authModal')?.classList.remove('show');
  }

  function api() {
    return {
      init,
      getStore: () => localStore,
      getState: () => ({ user: currentUser, session: currentSession, vehicle, status: currentStatus, configured: Boolean(remote), authReady }),
      onLegacyStateChanged,
      recordDeleted,
      syncNow,
      listConflicts,
      resolveConflict,
      signIn,
      signUp,
      signInWithGoogle,
      signOut,
      resetPassword,
      openAuth,
      closeAuth,
    };
  }

  return api();
}

export function installUi(backend, windowRef = globalThis) {
  const documentRef = windowRef.document;
  if (!documentRef) return;
  const email = documentRef.getElementById('authEmail');
  const password = documentRef.getElementById('authPassword');
  const fullName = documentRef.getElementById('authName');
  const form = documentRef.getElementById('authForm');
  const modeToggle = documentRef.getElementById('authModeToggle');
  const title = documentRef.getElementById('authTitle');
  const submit = documentRef.getElementById('authSubmit');
  const nameField = documentRef.getElementById('authNameWrap');
  const feedback = documentRef.getElementById('authFeedback');
  const accountView = documentRef.getElementById('authAccountView');
  const formView = documentRef.getElementById('authFormView');
  const google = documentRef.getElementById('authGoogle');
  const forgot = documentRef.getElementById('authForgot');
  let mode = 'signIn';

  const showFeedback = (message, isError = false) => {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.error = isError ? 'true' : 'false';
  };
  const render = () => {
    const state = backend.getState();
    const authenticated = Boolean(state.user);
    const authResolved = state.authReady !== false;
    if (accountView) accountView.hidden = !authenticated;
    if (formView) formView.hidden = authenticated;
    if (authenticated) {
      const accountEmail = documentRef.getElementById('authAccountEmail');
      if (accountEmail) accountEmail.textContent = state.user.email ?? 'Conta conectada';
    }
    const accountButton = documentRef.querySelector('[data-open-auth]');
    if (accountButton) {
      accountButton.textContent = authResolved ? (authenticated ? 'Conta' : 'Entrar') : 'Carregando…';
      accountButton.disabled = !authResolved;
      accountButton.setAttribute?.('aria-busy', String(!authResolved));
    }
    if (title) title.textContent = mode === 'signIn' ? 'Entrar no Saldo Final' : 'Criar sua conta';
    if (submit) submit.textContent = mode === 'signIn' ? 'Entrar' : 'Criar conta';
    if (modeToggle) modeToggle.textContent = mode === 'signIn' ? 'Ainda não tenho conta' : 'Já tenho uma conta';
    if (nameField) nameField.hidden = mode === 'signIn';
  };
  windowRef.SaldoFinalAuthUi = { render };
  modeToggle?.addEventListener('click', () => { mode = mode === 'signIn' ? 'signUp' : 'signIn'; showFeedback(''); render(); });
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFeedback('Aguarde…');
    try {
      if (mode === 'signIn') await backend.signIn(email.value.trim(), password.value);
      else await backend.signUp(email.value.trim(), password.value, fullName?.value.trim() ?? '');
      showFeedback(mode === 'signIn' ? 'Conta conectada.' : 'Conta criada. Verifique seu e-mail se for solicitado.');
      render();
    } catch (error) { showFeedback(error.message ?? 'Não foi possível concluir.', true); }
  });
  google?.addEventListener('click', async () => {
    showFeedback('Abrindo o Google…');
    try { await backend.signInWithGoogle(); } catch (error) { showFeedback(error.message ?? 'Google indisponível.', true); }
  });
  forgot?.addEventListener('click', async () => {
    if (!email?.value.trim()) return showFeedback('Digite seu e-mail primeiro.', true);
    try { await backend.resetPassword(email.value.trim()); showFeedback('Link de recuperação enviado.'); }
    catch (error) { showFeedback(error.message ?? 'Não foi possível enviar o link.', true); }
  });
  documentRef.getElementById('authLogout')?.addEventListener('click', async () => {
    try { await backend.signOut(); render(); showFeedback('Você saiu da conta.'); }
    catch (error) { showFeedback(error.message ?? 'Não foi possível sair.', true); }
  });
  documentRef.querySelectorAll('[data-open-auth]').forEach((button) => button.addEventListener('click', () => backend.openAuth()));
  documentRef.querySelectorAll('[data-close-auth]').forEach((button) => button.addEventListener('click', () => backend.closeAuth()));
  documentRef.querySelectorAll('[data-open-backup]').forEach((button) => button.addEventListener('click', () => {
    backend.closeAuth();
    documentRef.getElementById('backupModal')?.classList.add('show');
  }));
  render();
}

if (typeof window !== 'undefined') {
  const backend = createBackend({ windowRef: window, DB: window.SaldoFinalDB });
  window.SaldoFinalBackend = backend;
  window.openAuth = () => backend.openAuth();
  window.closeAuth = () => backend.closeAuth();
  installUi(backend, window);
  backend.init().catch((error) => {
    console.error('[Saldo Final] backend init failed', error);
    window.SaldoFinalToast?.('Modo local ativado');
  });
}
