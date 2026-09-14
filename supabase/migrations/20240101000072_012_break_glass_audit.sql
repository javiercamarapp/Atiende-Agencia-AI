-- Fase 10 rentas -- "romper cristal" (break-glass): acceso auditado de un Superadmin
-- de PLATAFORMA a los datos de un tenant específico de rentas, fuera del flujo normal
-- de autorización (RLS por membership), con razón obligatoria y bitácora INMUTABLE.
--
-- Gap verificado contra el código real antes de construirse (no se asumió la
-- descripción del gap sin leer): `packages/core-authz/src/impersonation/*` YA existe
-- en main (audit.ts, cookie.ts, resolve.ts, errors.ts) -- es un mecanismo real de
-- "ver como" (view-as) que resuelve la organización efectiva de un superadmin y la
-- anota en una bitácora con DEDUPE DIARIO. Pero NO es el mecanismo que pide este gap:
--   1. `recordImpersonation` NUNCA captura una razón -- ni el tipo `ImpersonationAuditEntry`
--      ni la firma de `recordImpersonation` tienen un campo `reason`.
--   2. Su único adaptador real es `InMemoryImpersonationAuditStore` -- no existe
--      ninguna tabla Postgres para esa bitácora todavía (confirmado: `grep -ri
--      impersonat` sobre supabase/migrations y packages/*/migrations no matcheó nada).
--   3. Es "best-effort" a propósito (ver cabecera de audit.ts: "un fallo de auditoría
--      nunca debe bloquear al superadmin") y con dedupe de UNA fila por día -- correcto
--      para su propósito (navegar el panel como si fueras el tenant), un antipatrón
--      para un incidente de "romper cristal" (cada acceso de emergencia debe quedar
--      registrado, nunca colapsado con el de ayer).
--   4. No registra QUÉ datos se vieron -- solo qué organización se seleccionó.
-- Es decir: el mecanismo GENÉRICO de impersonación (identidad del superadmin + cómo se
-- firma "qué organización estoy mirando") ya existe y esta fase lo REUTILIZA
-- (`SuperadminActor` de `@atiende/core-authz`, ver break-glass/tipos.ts) en vez de
-- reinventarlo; lo que esta migración + su contraparte TS construyen es la pieza que
-- de verdad faltaba: razón OBLIGATORIA, bitácora FAIL-CLOSED (sin fila de auditoría
-- persistida, no hay datos devueltos -- ver break-glass/acceso.ts::leerDatosTenantBreakGlass),
-- inmutable a nivel de Postgres, y con el resultado exacto de la lectura adjunto a la
-- fila (`result_summary`).
--
-- Diseño de inmutabilidad -- mismo patrón EXACTO que
-- packages/domain-hoteles/migrations/010_checador_asistencia.sql
-- (hoteles.attendance_log: append-only, encadenado por hash, triggers que bloquean
-- UPDATE/DELETE incondicionalmente, incluso para el dueño de la migración/service_role
-- -- defensa en profundidad, no solo ausencia de policy de escritura), con una
-- diferencia deliberada en el ALCANCE de la cadena:
--   - attendance_log encadena POR EMPLEADO (la inspección real, STPS, es "el historial
--     de ESTE trabajador").
--   - break_glass_access_log encadena POR ORGANIZACIÓN (el tenant afectado): la
--     inspección real aquí es "¿alguien manipuló el historial de accesos de EMERGENCIA
--     a MIS datos?" -- la pregunta que un tenant (o su auditor) hace es sobre SU propia
--     organización, igual que STPS pregunta por UN empleado. Encadenar globalmente (una
--     sola cabeza para todos los tenants) uniría en una sola cadena organizaciones que
--     no tienen relación entre sí sin necesidad real, y encadenar por actor (el
--     superadmin) dejaría a un tenant sin forma de verificar la integridad de SU propio
--     historial sin depender de la identidad de quién lo accedió.
--
-- Requiere: 0001_core_schema.sql (core.organization, core.staff_user, core.membership),
-- 001_rentas_schema.sql (rentas.ocupacion, rentas.guest_minimo, usados por la lectura
-- concreta que compone esta fase -- ver break-glass/acceso.ts::leerReservasTenantBreakGlass).

-- ---------------------------------------------------------------------------
-- 0) rentas.is_platform_superadmin -- el único predicado DB-enforceable de "¿quién es
--    Superadmin de plataforma?" que este monorepo puede sostener hoy sin inventar una
--    tabla nueva de roles de plataforma (decisión fuera de alcance de esta fase, ver
--    comentario de cabecera de packages/core-authz/src/impersonation/resolve.ts:
--    "Este módulo nunca decide QUIÉN es superadmin... eso es un hecho de sesión").
--    Se apoya en el invariante YA DOCUMENTADO por ese mismo módulo: "el superadmin...
--    (a diferencia de Membership en core-tenancy) no pertenece a NINGUNA organización
--    por diseño -- es un actor de PLATAFORMA". Un `core.staff_user` con CERO filas de
--    `core.membership` es, por ese invariante, un superadmin -- condición NECESARIA
--    real y verificable en SQL, no una condición inventada para esta migración.
--    LIMITACIÓN HONESTA (documentada, no escondida): esto es un proxy por ausencia de
--    membership, no un flag positivo "es_superadmin=true". Si algún día el monorepo
--    agrega una tabla dedicada de roles de plataforma, esta función debe apuntar ahí en
--    vez de aquí -- se deja este comentario como el gancho para ese cambio futuro.
-- ---------------------------------------------------------------------------
create or replace function rentas.is_platform_superadmin(_user_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select exists (select 1 from core.staff_user s where s.id = _user_id)
     and not exists (select 1 from core.membership m where m.user_id = _user_id)
$$;

-- ---------------------------------------------------------------------------
-- 1) break_glass_access_log -- registro real, append-only, encadenado por hash POR
--    ORGANIZACIÓN (ver razonamiento arriba). Cada fila es UN uso del mecanismo: no hay
--    fila "intento" separada de fila "resultado" -- `leerDatosTenantBreakGlass` (TS)
--    ejecuta la lectura PRIMERO, arma `result_summary` con lo que de verdad se
--    devolvió, y recién entonces inserta esta fila; si el INSERT falla, la función TS
--    nunca devuelve los datos ya leídos al llamador (fail-closed en la capa de
--    dominio, ver break-glass/acceso.ts) -- Postgres no puede expresar esa parte
--    (“no entregues lo que ya calculaste”), por eso la garantía vive ahí, no aquí; lo
--    que SÍ vive aquí es que, una vez escrita, la fila jamás puede alterarse ni
--    desaparecer.
-- ---------------------------------------------------------------------------
create table rentas.break_glass_access_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references core.staff_user(id) on delete restrict,
  -- Snapshot al momento del acceso -- un staff_user puede cambiar de correo después;
  -- la bitácora debe reflejar lo que era cierto CUANDO ocurrió el acceso, mismo
  -- criterio que `actorEmail` en core-authz/impersonation/audit.ts.
  actor_email text,
  organization_id uuid not null references core.organization(id) on delete restrict,
  -- Razón obligatoria -- el requisito central del gap. Mínimo 20 caracteres TRIMEADOS:
  -- fuerza una justificación real ("ticket SOP-4821: el tenant reporta que su
  -- statement de julio no cuadra, necesito ver sus movimientos financieros para
  -- diagnosticar"), no un placeholder de una palabra ("urgente", "revisión"). Mismo
  -- valor que BREAK_GLASS_MIN_REASON_LENGTH en break-glass/tipos.ts -- defensa en
  -- profundidad DB-side, nunca la única barrera (la barrera real es la del dominio).
  reason text not null check (char_length(btrim(reason)) >= 20),
  resource_type text not null check (resource_type in (
    'reservas', 'ocupaciones', 'finanzas', 'owner_statements', 'payouts',
    'pricing', 'mensajeria', 'limpieza', 'sync_ical', 'otro'
  )),
  -- Lo que se PIDIÓ leer (alcance declarado por el llamador antes de ejecutar la
  -- lectura) -- ej. {"propertyId": "..."} o {} para "todo el tenant".
  resource_scope jsonb not null default '{}'::jsonb,
  -- Lo que REALMENTE se devolvió -- "qué datos exactos se vieron" (mandato del gap):
  -- ej. {"reservaIds": ["...", "..."], "total": 2}. Construido DESPUÉS de ejecutar la
  -- lectura real, nunca antes -- ver break-glass/acceso.ts.
  result_summary jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  seq bigint generated always as identity,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
create unique index break_glass_access_log_seq_idx on rentas.break_glass_access_log (seq);
create index break_glass_access_log_org_seq_idx on rentas.break_glass_access_log (organization_id, seq);
create index break_glass_access_log_actor_idx on rentas.break_glass_access_log (actor_user_id, occurred_at);

-- Cabeza de cadena por organización, bloqueada con FOR UPDATE dentro del trigger --
-- mismo mecanismo que hoteles.attendance_log_chain_head.
create table rentas.break_glass_chain_head (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  hash text
);
revoke all on rentas.break_glass_chain_head from public, anon, authenticated;
alter table rentas.break_glass_chain_head enable row level security;
-- Sin ninguna policy: solo el trigger de abajo (SECURITY DEFINER) la toca.

create or replace function rentas.break_glass_log_set_hash()
returns trigger
language plpgsql
security definer
set search_path = rentas
as $$
declare
  v_prev_hash text;
  v_occurred_at timestamptz;
  v_canonical text;
begin
  insert into rentas.break_glass_chain_head (organization_id, hash)
  values (new.organization_id, null)
  on conflict (organization_id) do nothing;

  select hash into v_prev_hash
  from rentas.break_glass_chain_head
  where organization_id = new.organization_id
  for update;

  v_occurred_at := coalesce(new.occurred_at, now());

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.actor_user_id::text
    || '|' || coalesce(new.actor_email, '')
    || '|' || new.organization_id::text
    || '|' || new.reason
    || '|' || new.resource_type
    || '|' || new.resource_scope::text
    || '|' || new.result_summary::text
    || '|' || v_occurred_at::text;

  new.prev_hash := v_prev_hash;
  new.occurred_at := v_occurred_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  update rentas.break_glass_chain_head set hash = new.hash where organization_id = new.organization_id;

  return new;
end;
$$;

create trigger break_glass_access_log_set_hash_trg
  before insert on rentas.break_glass_access_log
  for each row execute function rentas.break_glass_log_set_hash();

create or replace function rentas.break_glass_access_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'break_glass_access_log_append_only: % no está permitido sobre rentas.break_glass_access_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger break_glass_access_log_block_update_trg
  before update on rentas.break_glass_access_log
  for each row execute function rentas.break_glass_access_log_block_mutation();
create trigger break_glass_access_log_block_delete_trg
  before delete on rentas.break_glass_access_log
  for each row execute function rentas.break_glass_access_log_block_mutation();

-- ---------------------------------------------------------------------------
-- 2) RLS -- escritura: SOLO el propio superadmin, sobre SU PROPIO id de actor, y solo
--    si `rentas.is_platform_superadmin` lo confirma (defensa en profundidad: incluso si
--    un bug futuro de la ruta HTTP dejara pasar a alguien con membership, la policy lo
--    rechaza). Lectura: el propio actor ve su historial (transparencia estándar de
--    bitácora, mismo criterio que `staff_user_id = auth.uid()` en attendance_log) y
--    `admin_gestora` del tenant afectado ve los accesos de emergencia a SU organización
--    (el tenant tiene derecho a saber cuándo y por qué alguien de la plataforma vio sus
--    datos fuera del flujo normal -- el propósito completo de auditar "romper cristal"
--    se pierde si el tenant nunca puede consultarlo).
-- ---------------------------------------------------------------------------
alter table rentas.break_glass_access_log enable row level security;

create policy "break-glass: el superadmin ve su propio historial de accesos" on rentas.break_glass_access_log for select
  using (actor_user_id = auth.uid());

create policy "break-glass: admin_gestora del tenant ve accesos de emergencia a su organización" on rentas.break_glass_access_log for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = break_glass_access_log.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role = 'admin_gestora'
  ));

create policy "break-glass: solo un superadmin real inserta a nombre de sí mismo" on rentas.break_glass_access_log for insert
  with check (
    actor_user_id = auth.uid()
    and rentas.is_platform_superadmin(auth.uid())
  );

-- Sin policy de UPDATE/DELETE para NINGÚN rol -- los triggers de bloqueo de arriba lo
-- impiden de todas formas para cualquiera, incluido `service_role` (defensa en
-- profundidad, mismo criterio que hoteles.attendance_log).
revoke all on rentas.break_glass_access_log from public, anon;
grant select, insert on rentas.break_glass_access_log to authenticated;
grant select, insert, update, delete on rentas.break_glass_access_log to service_role;
