import { createId, makeOutboxId } from './saldo-backend-model.mjs';

function sameVersion(local, remote) {
  const localVersion = local?.updatedAt ?? local?.updated_at ?? null;
  const remoteVersion = remote?.updatedAt ?? remote?.updated_at ?? null;
  return Boolean(localVersion && remoteVersion && localVersion === remoteVersion);
}

function errorMessage(error) {
  return error?.message ?? String(error ?? 'Falha de sincronização');
}

function isRemoteRecord(record) {
  return Boolean(record && (
    record.user_id !== undefined
    || record.record_date !== undefined
    || record.fuel_date !== undefined
    || record.expense_date !== undefined
    || record.period_type !== undefined
  ));
}

export function createSyncEngine({
  store,
  remote,
  entities,
  serialize = (_entity, record) => record,
  deserialize = (_entity, record) => record,
  now = () => new Date().toISOString(),
  userId = null,
  vehicleId = null,
  idFactory = createId,
} = {}) {
  if (!store) throw new Error('Sync engine precisa de um store');
  if (!remote) throw new Error('Sync engine precisa de um remote');
  const syncEntities = [...(entities ?? [])];
  let stopped = false;

  async function enqueueUpsert(entity, localRecord) {
    const payload = serialize(entity, localRecord, { userId, vehicleId, now: now() });
    const id = makeOutboxId(entity, payload.id ?? localRecord.id);
    const previous = await store.get('outbox', id);
    await store.enqueue({
      id,
      entity,
      action: 'upsert',
      record: payload,
      createdAt: previous?.createdAt ?? now(),
      attempts: previous?.attempts ?? 0,
      status: 'pending',
      lastError: null,
    });
    return id;
  }

  async function enqueueDelete(entity, localRecord) {
    return enqueueUpsert(entity, { ...localRecord, deletedAt: localRecord.deletedAt ?? now() });
  }

  async function flush() {
    const pending = (await store.listOutbox())
      .filter((operation) => operation.status !== 'conflict')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const result = { attempted: pending.length, synced: 0, failed: 0 };
    for (const operation of pending) {
      if (stopped) break;
      try {
        const response = await remote.upsert(operation.entity, operation.record);
        if (response?.error) throw response.error;
        await store.delete('outbox', operation.id);
        result.synced += 1;
      } catch (error) {
        result.failed += 1;
        await store.updateOutbox(operation.id, {
          attempts: (operation.attempts ?? 0) + 1,
          status: 'pending',
          lastError: errorMessage(error),
          lastAttemptAt: now(),
        });
      }
    }
    return result;
  }

  async function pull() {
    const result = { entities: 0, conflicts: 0, errors: 0 };
    for (const entity of syncEntities) {
      if (stopped) break;
      const cursorKey = `sync:${entity}:cursor`;
      const since = await store.getMeta(cursorKey, null);
      try {
        const response = await remote.list(entity, { userId, vehicleId, since });
        if (response?.error) throw response.error;
        let cursor = since;
        for (const remoteRecord of response?.data ?? []) {
          const recordId = remoteRecord.id;
          const outbox = await store.get('outbox', makeOutboxId(entity, recordId));
          const local = await store.get(entity, recordId);
          if (outbox && !sameVersion(outbox.record, remoteRecord)) {
            const conflictId = `${entity}:${recordId}:${remoteRecord.updated_at ?? remoteRecord.updatedAt ?? idFactory()}`;
            await store.addConflict({
              id: conflictId,
              entity,
              recordId,
              ownerId: userId,
              local: local ?? (isRemoteRecord(outbox.record) ? deserialize(entity, outbox.record) : outbox.record),
              remote: remoteRecord,
              detectedAt: now(),
              status: 'open',
            });
            result.conflicts += 1;
          } else if (remoteRecord.deleted_at) {
            await store.delete(entity, recordId);
          } else {
            await store.put(entity, deserialize(entity, remoteRecord));
            result.entities += 1;
          }
          const version = remoteRecord.updated_at ?? remoteRecord.updatedAt ?? null;
          if (version && (!cursor || version > cursor)) cursor = version;
        }
        if (cursor && cursor !== since) await store.setMeta(cursorKey, cursor);
      } catch {
        result.errors += 1;
      }
    }
    return result;
  }

  async function listConflicts({ status = null } = {}) {
    const conflicts = await store.listConflicts();
    return conflicts.filter((conflict) => !status || conflict.status === status);
  }

  async function resolveConflict(conflictId, resolution) {
    if (resolution !== 'local' && resolution !== 'remote') {
      throw new Error('A resolução deve ser local ou remota');
    }
    const conflict = await store.get('conflicts', conflictId);
    if (!conflict) throw new Error('Conflito não encontrado');
    if (conflict.status === 'resolved') return conflict;

    const outboxId = makeOutboxId(conflict.entity, conflict.recordId);
    if (resolution === 'local') {
      if (!conflict.local) throw new Error('A versão local do conflito não está disponível');
      const local = isRemoteRecord(conflict.local) ? deserialize(conflict.entity, conflict.local) : conflict.local;
      const chosen = {
        ...local,
        ownerId: local.ownerId ?? userId,
        vehicleId: local.vehicleId ?? vehicleId,
        updatedAt: now(),
      };
      await store.put(conflict.entity, chosen);
      await enqueueUpsert(conflict.entity, chosen);
    } else {
      const remoteRecord = conflict.remote;
      if (remoteRecord?.deleted_at ?? remoteRecord?.deletedAt) await store.delete(conflict.entity, conflict.recordId);
      else await store.put(conflict.entity, deserialize(conflict.entity, remoteRecord));
      await store.delete('outbox', outboxId);
    }

    const resolved = {
      ...conflict,
      status: 'resolved',
      resolution,
      resolvedAt: now(),
    };
    await store.put('conflicts', resolved);
    return resolved;
  }

  async function sync() {
    const pushed = await flush();
    const pulled = await pull();
    return { pushed, pulled };
  }

  return {
    enqueueUpsert,
    enqueueDelete,
    flush,
    pull,
    listConflicts,
    resolveConflict,
    sync,
    stop() { stopped = true; },
    resume() { stopped = false; },
  };
}
