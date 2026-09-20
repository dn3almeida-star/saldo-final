export function createAuthService({ client }) {
  if (!client?.auth) throw new Error('O serviço de autenticação precisa de um cliente Supabase');
  return {
    async getSession() {
      return client.auth.getSession();
    },
    onChange(callback) {
      const subscription = client.auth.onAuthStateChange(callback);
      return () => subscription?.data?.subscription?.unsubscribe?.();
    },
    async signUp({ email, password, fullName = '' }) {
      return client.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName } },
      });
    },
    async signIn({ email, password }) {
      return client.auth.signInWithPassword({ email, password });
    },
    async signInWithGoogle({ redirectTo } = {}) {
      return client.auth.signInWithOAuth({
        provider: 'google',
        options: redirectTo ? { redirectTo } : undefined,
      });
    },
    async signOut() {
      return client.auth.signOut();
    },
    async resetPassword(email, redirectTo) {
      return client.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined);
    },
  };
}
