import { TABLES } from './saldo-backend-model.mjs';

function tableFor(entity) {
  const table = TABLES[entity];
  if (!table) throw new Error(`Entidade remota desconhecida: ${entity}`);
  return table;
}

export function createSupabaseRemote({ client }) {
  if (!client) throw new Error('O adaptador Supabase precisa de um cliente');
  return {
    async upsert(entity, payload) {
      return client.from(tableFor(entity)).upsert(payload, { onConflict: 'id' }).select('*').maybeSingle();
    },
    async list(entity, { userId, vehicleId = null, since = null } = {}) {
      let query = client.from(tableFor(entity)).select('*').eq('user_id', userId).order('updated_at', { ascending: true });
      if (vehicleId) query = query.eq('vehicle_id', vehicleId);
      if (since) query = query.gt('updated_at', since);
      return query;
    },
    async getProfile(userId) {
      return client.from('profiles').select('*').eq('id', userId).maybeSingle();
    },
    async upsertProfile(payload) {
      return client.from('profiles').upsert(payload, { onConflict: 'id' }).select('*').maybeSingle();
    },
    async getVehicle(userId) {
      return client.from('vehicles').select('*').eq('user_id', userId).is('deleted_at', null).maybeSingle();
    },
    async upsertVehicle(payload) {
      return client.from('vehicles').upsert(payload, { onConflict: 'id' }).select('*').maybeSingle();
    },
  };
}
