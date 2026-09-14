// Suscripción en tiempo real de la Agenda (Fase 10) — puerto real del patrón del
// origen (citas-reservaciones/src/components/admin/AgendaSection.tsx:
// `.channel(agenda-${tenantId})` + `.on("postgres_changes", ...)` → recarga vía
// nonce cuando cambia una cita), adaptado a las 3 diferencias reales de este
// monorepo (verificadas contra el código de esta rama, no supuestas):
//
//   1. Autenticación. El origen abre el canal dentro de una sesión real de
//      Supabase Auth (browser → supabase directo, `auth.uid()` ya resuelto por
//      GoTrue). Este monorepo NUNCA usa Supabase Auth — el panel de citas
//      inicia sesión con el JWT propio de @atiende/core-auth (HS256, ver
//      jwt.ts), y la API verifica ESE token, no uno de Supabase. Por eso este
//      cliente llama `client.realtime.setAuth(accessToken)` con el MISMO
//      access token que ya usa cada fetch autenticado a la API (documentado
//      por la propia librería para "Realtime RLS", ver RealtimeClient.d.ts) en
//      vez de abrir una sesión de `supabase.auth`.
//
//      BLOQUEO REAL (no resuelto por este cambio, documentado en vez de
//      fingirlo): para que ese token autorice algo, el proyecto Supabase real
//      detrás de este monorepo tiene que verificar JWT HS256 firmados con el
//      MISMO secreto que usa `signAccessToken` (env `JWT_SECRET` de
//      apps/api) — eso es una alineación de configuración del proyecto
//      Supabase (dashboard/API, "verify custom JWTs"), no algo que este
//      repo pueda fijar por código, y esta sesión no tiene credenciales de
//      administración de ese proyecto para configurarlo. Sin esa alineación
//      el socket se conecta pero Postgres nunca resuelve `auth.uid()` para
//      esa conexión → la policy RLS ya existente de citas.appointments
//      ("staff ve citas de su organización", 001_citas_schema.sql) no
//      autoriza nada y el canal simplemente no entrega eventos — falla
//      cerrado, sin fuga de datos entre organizaciones, y el panel sigue
//      funcionando exactamente igual que hoy (fetch manual tras cada acción)
//      hasta que esa alineación de secretos exista.
//
//   2. Esquema. La tabla real es `citas.appointments` (este monorepo separa
//      cada vertical en su propio schema Postgres desde 001_citas_schema.sql),
//      no `public.appointments` como en el origen standalone.
//
//   3. Filtro. La columna real es `organization_id` (ver
//      packages/domain-citas/migrations/001_citas_schema.sql), no `tenant_id`
//      como en el origen.
//
// Lo que este archivo NO hace, a propósito: nunca lee el `payload` del evento
// de Realtime como fuente de datos. `onChange` solo dispara un refetch por la
// misma ruta ya autenticada/autorizada de siempre (fetchAppointments vía la
// API) — exactamente el mismo patrón que el origen (su callback también
// ignora el payload y solo incrementa un nonce que dispara `cargar()`). Así
// Realtime es puramente la señal de "algo cambió, vuelve a pedir los datos
// reales" — nunca un canal alterno de lectura de datos que pudiera divergir
// del control de acceso real de la API.
//
// Sin las 2 env vars de abajo (proyecto Supabase con Realtime configurado)
// este módulo no truena: `getRealtimeClient()` devuelve `null` y
// `subscribeToAppointmentChanges` se vuelve no-op — el panel sigue con el
// fetch manual de siempre.
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

export function appointmentsChannelName(organizationId: string): string {
  return `agenda-${organizationId}`;
}

export function appointmentsChangesFilter(organizationId: string): string {
  return `organization_id=eq.${organizationId}`;
}

let cachedClient: SupabaseClient | null | undefined;

/** `undefined` (interno) = todavía no resuelto; `null` = Realtime no está
 * configurado en este deploy (faltan VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY). */
export function getRealtimeClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";
  cachedClient = url && anonKey ? createClient(url, anonKey) : null;
  return cachedClient;
}

/** Se suscribe a cambios de `citas.appointments` de una organización y llama
 * `onChange()` (nunca con el payload, ver cabecera del archivo). Devuelve la
 * función de limpieza (`removeChannel`). No-op si Realtime no está
 * configurado (`client` null, el caso por defecto de `getRealtimeClient()`).
 * `client` es inyectable (mismo criterio de `fetchImpl` en el resto de este
 * panel, ver appointments-client.ts) para poder probar esta función con
 * vitest en entorno "node" sin abrir un WebSocket real. */
export function subscribeToAppointmentChanges(organizationId: string, accessToken: string, onChange: () => void, client: SupabaseClient | null = getRealtimeClient()): () => void {
  if (!client) return () => {};
  void client.realtime.setAuth(accessToken);
  const channel = client
    .channel(appointmentsChannelName(organizationId))
    .on("postgres_changes", { event: "*", schema: "citas", table: "appointments", filter: appointmentsChangesFilter(organizationId) }, () => onChange())
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}
