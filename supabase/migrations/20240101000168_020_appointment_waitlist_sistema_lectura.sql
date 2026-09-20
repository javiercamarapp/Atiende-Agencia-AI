-- Hallazgo verificado contra Postgres real (f2-citas-lista-de-espera, revisores
-- 19-sep -- ver /Users/javiercamaraportepetit/atiende-loop/auditorias/
-- pr174-veredicto.json, "Gap de RLS NUEVO descubierto" en el PR #174, ya en
-- main): `citas.appointment_waitlist` (003_waitlist_and_rate_limit.sql) tiene
-- UNA sola policy, de STAFF autenticado:
--
--   create policy "staff gestiona lista de espera de su organización" ...
--     using (exists (select 1 from core.membership m
--                    where m.organization_id = appointment_waitlist.organization_id
--                      and m.user_id = auth.uid()));
--
-- Bajo sesión de SISTEMA (`auth.uid()` NULL -- el agente de voz/WhatsApp
-- cancelando/reagendando/reasignando una cita, y el broadcast manual del staff
-- que esta misma migración mueve a sesión de sistema post-commit, ver
-- `apps/api/.../citas/admin.ts`) esa policy NUNCA aplica: cualquier SELECT
-- plano contra esta tabla devuelve CERO filas, EN SILENCIO, sin ninguna
-- excepción -- exactamente el mismo patrón ya documentado en el README raíz
-- ("Sesión de sistema sin acceso a core.property") y en
-- `scripts/verify-citas-cancelar-con-lista-de-espera/assertions.sql`
-- ("GAP RLS", sección final, NO corregida ahí a propósito -- venía fuera de
-- alcance de esa tarea).
--
-- Impacto real, verificado en el verify script de esta migración
-- (`scripts/verify-citas-lista-de-espera-sistema/`): el aviso automático de
-- lista de espera (`runOptimizadorCore`, disparado SIEMPRE en sesión de
-- sistema -- cancelar/reagendar/reasignar del agente de voz/WhatsApp, Y
-- `runCitasWaitlistNotifyAfterCancel` post-commit para el cancelar de staff,
-- ver PR #174) nunca ha podido ver un candidato real contra Postgres, desde
-- que existe la lista de espera -- no es una regresión de este PR, es un gap
-- que existía desde 003 y que el PR #174 solo documentó sin cerrar (fuera de
-- su alcance asignado).
--
-- Diseño (mismo criterio caso-por-caso que
-- `...000139_022_hoteles_sistema_voz_whatsapp_escritura.sql`, que este
-- comentario sigue como plantilla): `citas.appointment_waitlist` guarda
-- `customer_phone`/`customer_name` -- PII de contacto de un cliente, no una
-- credencial de plataforma, pero tampoco un catálogo de enrutamiento inerte
-- como `core.property`/`hoteles.whatsapp_channel_config`. Un escape hatch
-- `auth.uid() is null or <regla de staff>` en la policy `for all` existente
-- ampliaría TAMBIÉN insert/update/delete a sesión de sistema (hoy
-- correctamente reservados al panel de staff -- el agente nunca inserta ni
-- borra filas de la lista de espera, ver domain-citas/src/reminders.ts) --
-- se descarta, igual que se descartó para `hoteles.voice_agent_config`.
--
-- En su lugar: función `security definer` de SOLO-SISTEMA
-- (`citas.system_load_live_waitlist_candidates`), guard `auth.uid() is null`
-- (mismo patrón que `citas.claim_waitlist_notification_slot`,
-- 015_rpc_anti_duplicado_authenticated_grants.sql), que devuelve el MISMO
-- mínimo de columnas que ya seleccionaba `loadLiveWaitlistCandidates` (nunca
-- `status`/`expires_at`/`organization_id`, que son solo criterio de filtro
-- interno) -- nunca un GRANT plano de SELECT sobre toda la tabla a sesión de
-- sistema. La policy `for all` original de staff NO se toca: el panel
-- (`GET /v1/citas/properties/:propertyId/waitlist`, listado de solo lectura
-- para que el staff vea a quién le toca antes de decidir el broadcast) sigue
-- exactamente igual, vía RLS real de staff, sin pasar por esta función.
--
-- Columnas `date` con `::text` (regla dura de este repo -- pg entrega `date`
-- como objeto `Date`, no string; ver p.ej.
-- `domain-hoteles/src/postgres-repository.ts`): `preferred_date_from`/
-- `preferred_date_to` se casteaban SIN `::text` en el SELECT original de
-- `postgres-repository.ts::loadLiveWaitlistCandidates` -- bug preexistente e
-- independiente de este gap de RLS (nunca visible en los tests en memoria,
-- que no pasan por el driver `pg` real), corregido aquí Y en esa misma
-- consulta (ver el commit de código de esta misma tarea).
--
-- Orden de despliegue: código y migración son independientes en ambas
-- direcciones -- `loadLiveWaitlistCandidatesAsSystem` (nuevo método,
-- `postgres-repository.ts`) usa `runWithSavepointFallback` +
-- `isUndefinedFunctionError` (SQLSTATE 42883): si el código nuevo se
-- despliega ANTES que esta migración, cae a lista vacía (el mismo
-- comportamiento honesto de HOY: cero candidatos vistos, nunca un 500) en vez
-- de dejar la transacción abortada. No hay ORDEN obligatorio; aplicar esta
-- migración es lo que de verdad activa el aviso -- ver el README de este
-- paquete para el detalle completo.
create or replace function citas.system_load_live_waitlist_candidates(p_organization_id uuid)
returns table (
  out_id uuid,
  out_customer_phone text,
  out_customer_name text,
  out_notified_count integer,
  out_provider_id uuid,
  out_service_id uuid,
  out_preferred_date_from text,
  out_preferred_date_to text,
  out_preferred_time_window text,
  out_created_at timestamptz
)
language plpgsql
security definer
set search_path = citas
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_load_live_waitlist_candidates es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select w.id, w.customer_phone, w.customer_name, w.notified_count, w.provider_id, w.service_id,
           w.preferred_date_from::text, w.preferred_date_to::text, w.preferred_time_window, w.created_at
    from citas.appointment_waitlist w
    where w.organization_id = p_organization_id
      and w.status = 'active'
      and w.expires_at > now()
      and w.notified_count < 3;
end;
$$;

revoke all on function citas.system_load_live_waitlist_candidates(uuid) from public, anon, authenticated;
grant execute on function citas.system_load_live_waitlist_candidates(uuid) to authenticated;
