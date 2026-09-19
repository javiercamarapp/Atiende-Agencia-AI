-- Fase 10b rentas -- cierra el gap señalado por la auditoría del 18-sep-2026
-- ("break-glass de superadmin construido pero desconectado de toda ruta HTTP")
-- y corrige, de paso, el hallazgo de seguridad que esa misma auditoría dejó
-- pasar: el criterio de "¿quién es Superadmin de plataforma?" que
-- `012_break_glass_audit.sql` usó para `rentas.is_platform_superadmin` era un
-- PROXY débil, documentado como tal en su propio comentario de cabecera
-- ("esto es un proxy por ausencia de membership, no un flag positivo... si
-- algún día el monorepo agrega una tabla dedicada de roles de plataforma,
-- esta función debe apuntar ahí -- se deja este comentario como el gancho
-- para ese cambio futuro").
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 0) CORRECCIÓN DE SEGURIDAD -- el criterio débil y su reemplazo
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El criterio original de `rentas.is_platform_superadmin(_user_id)` era
-- "existe un core.staff_user con ese id, Y ese staff_user no tiene NINGUNA
-- fila en core.membership" -- es decir, "superadmin" = "staff sin
-- membership", nunca un flag positivo. Esa es una condición NECESARIA (todo
-- superadmin real, en efecto, no pertenece a ninguna organización) pero NO
-- SUFICIENTE, y la brecha entre ambas es explotable por construcción normal
-- del producto, sin ningún bug adicional:
--
--   - Un staff RECIÉN CREADO (registro autoservicio, o invitado que todavía
--     no acepta su invitación) no tiene membership todavía -- el criterio lo
--     cuenta como superadmin mientras esa ventana dura.
--   - Un staff al que se le REVOCAN todas sus membresías (offboarding, o
--     simplemente el último acceso de una organización que cierra) también
--     queda, desde ese momento, sin ninguna fila en `core.membership` -- el
--     criterio lo sigue contando como superadmin para siempre después, sin
--     que nadie haya tomado esa decisión.
--
-- En ambos casos, cualquier función que autorice con
-- `rentas.is_platform_superadmin(auth.uid())` (hoy: la policy de INSERT de
-- `rentas.break_glass_access_log`) le concedería a esa cuenta el mismo
-- alcance que a un Superadmin real -- en el caso de break-glass, la
-- capacidad de leer datos de CUALQUIER organización de rentas fuera del flujo
-- normal de autorización. Es la misma CLASE de hallazgo que
-- `0011_superadmin_caller_binding.sql`/`0012_caller_binding_fase2.sql` ya
-- corrigieron para el schema `core` (un predicado de autorización que no
-- refleja una decisión explícita y auditable de "esta cuenta es superadmin"),
-- aplicado aquí al único lugar del schema `rentas` que todavía lo tenía.
--
-- La fuente de verdad real YA EXISTE desde `0010_platform_superadmin.sql`
-- (`core.platform_superadmin`, un flag POSITIVO: una fila por cuenta a la que
-- alguien, explícitamente, otorgó el rol -- `granted_at` queda registrado,
-- revocar es borrar la fila, nunca un efecto lateral de otro cambio) y su
-- función `core.is_platform_superadmin(p_staff_id)`, re-atada a la sesión real
-- por `0012_caller_binding_fase2.sql` (devuelve `true` solo si
-- `auth.uid() = p_staff_id` Y esa cuenta está en `core.platform_superadmin`).
-- El propio comentario de `012_break_glass_audit.sql` dejó explícito el gancho
-- para este cambio -- aquí se toma: `rentas.is_platform_superadmin` pasa a
-- DELEGAR en `core.is_platform_superadmin`, con la MISMA firma
-- (`uuid -> boolean`) para no romper la policy de `break_glass_access_log`
-- que ya la usa, y quedando atada a `auth.uid()` de forma transitiva (la
-- atadura vive en `core.is_platform_superadmin`, no se duplica aquí).
--
-- También se agrega el `revoke`/`grant` explícito que la función original
-- nunca tuvo (Postgres concede EXECUTE a PUBLIC por default en una función
-- nueva sin `revoke` explícito) -- mismo criterio que el resto de funciones
-- `security definer` de este monorepo: nunca alcanzable por `anon`, solo por
-- `authenticated` (el rol bajo el que corre toda sesión de `apps/api`, tenga
-- o no `auth.uid()` real, ver `ManagedPostgresEngine.withAppSession`).
create or replace function rentas.is_platform_superadmin(_user_id uuid)
returns boolean
language sql stable security definer set search_path = core, pg_temp
as $$
  select core.is_platform_superadmin(_user_id);
$$;

revoke all on function rentas.is_platform_superadmin(uuid) from public;
grant execute on function rentas.is_platform_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) rentas.break_glass_session -- la pieza que faltaba para que "romper
--    cristal" sea un ACCESO acotado en el tiempo (lo que pide el gap: "abrir
--    un acceso de emergencia... duración acotada"), no solo un log por
--    lectura. `012_break_glass_audit.sql` ya construyó la bitácora INMUTABLE
--    de qué se leyó y por qué (`break_glass_access_log`) pero nunca un
--    concepto de "ventana de acceso vigente" -- sin eso, no hay nada contra
--    lo que un 403 ("sin acceso activo") pueda evaluarse. Esta tabla es esa
--    ventana: se ABRE con motivo + duración, se puede CERRAR manualmente
--    antes de vencer, y vence sola por tiempo -- las lecturas de datos de
--    tenant (`rentas.list_reservas_for_break_glass`, abajo) exigen una fila
--    vigente para el mismo actor+organización antes de devolver nada.
-- ═══════════════════════════════════════════════════════════════════════════
create table rentas.break_glass_session (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references core.staff_user(id) on delete restrict,
  -- Snapshot al momento de abrir -- mismo criterio que actor_email en
  -- break_glass_access_log.
  actor_email text,
  organization_id uuid not null references core.organization(id) on delete restrict,
  -- Mismo mínimo que break_glass_access_log.reason (BREAK_GLASS_MIN_REASON_LENGTH
  -- en packages/domain-rentas/src/break-glass/tipos.ts) -- defensa en
  -- profundidad DB-side, la barrera real es la función de abajo.
  reason text not null check (char_length(btrim(reason)) >= 20),
  opened_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  closed_by uuid references core.staff_user(id),
  created_at timestamptz not null default now(),
  check (expires_at > opened_at),
  -- Duración acotada -- el requisito explícito del gap ("duración acotada").
  -- 4 horas es el mismo orden de magnitud que una guardia/turno de soporte;
  -- una ventana más larga que eso deja de ser "romper cristal" (emergencia
  -- puntual) y empieza a parecerse a acceso permanente -- si algún día se
  -- necesita más, es una decisión de producto explícita (cambiar este CHECK),
  -- nunca un default silencioso.
  check (expires_at <= opened_at + interval '4 hours'),
  check (closed_at is null or closed_at >= opened_at)
);

create index break_glass_session_actor_org_active_idx
  on rentas.break_glass_session (actor_user_id, organization_id, expires_at)
  where closed_at is null;
create index break_glass_session_org_idx on rentas.break_glass_session (organization_id, opened_at desc);

-- Trigger de inmutabilidad parcial: una fila puede CERRARSE (closed_at/closed_by,
-- una sola vez) pero ningún otro campo puede cambiar jamás después del INSERT --
-- mismo espíritu que los triggers de bloqueo total de break_glass_access_log,
-- adaptado porque aquí SÍ existe una transición de estado legítima (abierta ->
-- cerrada) que esa tabla no tiene.
create or replace function rentas.break_glass_session_guard_update()
returns trigger
language plpgsql
as $$
begin
  if old.actor_user_id is distinct from new.actor_user_id
     or old.organization_id is distinct from new.organization_id
     or old.reason is distinct from new.reason
     or old.opened_at is distinct from new.opened_at
     or old.expires_at is distinct from new.expires_at
  then
    raise exception 'break_glass_session_immutable: solo el cierre (closed_at/closed_by) puede escribirse después del alta -- ningún otro campo de rentas.break_glass_session puede modificarse'
      using errcode = '0A000';
  end if;
  if old.closed_at is not null then
    raise exception 'break_glass_session_immutable: esta sesión ya está cerrada -- no puede reabrirse ni volver a cerrarse'
      using errcode = '0A000';
  end if;
  return new;
end;
$$;

create trigger break_glass_session_guard_update_trg
  before update on rentas.break_glass_session
  for each row execute function rentas.break_glass_session_guard_update();

alter table rentas.break_glass_session enable row level security;

create policy "break-glass-session: el superadmin ve sus propias sesiones" on rentas.break_glass_session for select
  using (actor_user_id = auth.uid());

-- Visibilidad del tenant -- mismo criterio EXACTO que la policy de SELECT que
-- 012_break_glass_audit.sql ya otorgó sobre break_glass_access_log a
-- admin_gestora: el dueño de la organización tiene derecho a saber cuándo
-- alguien de la plataforma tiene (o tuvo) una ventana de acceso de emergencia
-- abierta contra SUS datos, no solo qué se leyó dentro de ella.
create policy "break-glass-session: admin_gestora del tenant ve accesos de emergencia a su organización" on rentas.break_glass_session for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = break_glass_session.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role = 'admin_gestora'
  ));

-- INSERT/UPDATE nunca directo desde un cliente -- ambas policies son defensa
-- en profundidad (mismo criterio que break_glass_access_log): la autoridad
-- real vive en las 3 funciones security definer de la sección 2, que además
-- validan motivo/duración/organización antes de tocar la tabla.
create policy "break-glass-session: solo un superadmin real inserta a nombre de sí mismo" on rentas.break_glass_session for insert
  with check (
    actor_user_id = auth.uid()
    and rentas.is_platform_superadmin(auth.uid())
  );

create policy "break-glass-session: solo el propio actor cierra su sesión" on rentas.break_glass_session for update
  using (actor_user_id = auth.uid() and rentas.is_platform_superadmin(auth.uid()))
  with check (actor_user_id = auth.uid());

revoke all on rentas.break_glass_session from public, anon;
grant select, insert, update on rentas.break_glass_session to authenticated;
grant select, insert, update, delete on rentas.break_glass_session to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Funciones security definer -- abrir/listar/cerrar. Mismo patrón EXACTO
--    que `core.*_for_superadmin` (0010_platform_superadmin.sql): `p_caller_id`
--    como parámetro plano, atado a `auth.uid()` DENTRO de la función (nunca
--    confiado del llamador), más `rentas.is_platform_superadmin(p_caller_id)`
--    -- la sesión de Postgres que las invoca debe ser la del superadmin real
--    (`engine.withAppSession({ userId: callerId })`), nunca una sesión de
--    sistema -- ver apps/api/src/production/rentas-break-glass-repository.ts.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function rentas.open_break_glass_session(
  p_caller_id uuid,
  p_organization_id uuid,
  p_reason text,
  p_duration_minutes integer
)
returns rentas.break_glass_session
language plpgsql
security definer
set search_path = rentas, core, pg_temp
as $$
declare
  v_row rentas.break_glass_session;
  v_email text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'open_break_glass_session: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(v_reason) < 20 then
    raise exception 'la razón de romper-cristal es obligatoria y debe tener al menos 20 caracteres' using errcode = '22023';
  end if;
  if p_duration_minutes is null or p_duration_minutes < 5 or p_duration_minutes > 240 then
    raise exception 'la duración del acceso debe estar entre 5 y 240 minutos' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organization where id = p_organization_id) then
    raise exception 'organización no encontrada' using errcode = 'P0002';
  end if;

  select s.email into v_email from core.staff_user s where s.id = p_caller_id;

  insert into rentas.break_glass_session (actor_user_id, actor_email, organization_id, reason, expires_at)
  values (p_caller_id, v_email, p_organization_id, v_reason, now() + make_interval(mins => p_duration_minutes))
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function rentas.open_break_glass_session(uuid, uuid, text, integer) from public;
grant execute on function rentas.open_break_glass_session(uuid, uuid, text, integer) to authenticated;

create or replace function rentas.list_break_glass_sessions_for_superadmin(p_caller_id uuid)
returns setof rentas.break_glass_session
language sql
stable
security definer
set search_path = rentas, core, pg_temp
as $$
  select s.* from rentas.break_glass_session s
  where auth.uid() is not null and auth.uid() = p_caller_id
    and rentas.is_platform_superadmin(p_caller_id)
    and s.actor_user_id = p_caller_id
  order by s.opened_at desc;
$$;

revoke all on function rentas.list_break_glass_sessions_for_superadmin(uuid) from public;
grant execute on function rentas.list_break_glass_sessions_for_superadmin(uuid) to authenticated;

create or replace function rentas.close_break_glass_session(p_caller_id uuid, p_session_id uuid)
returns rentas.break_glass_session
language plpgsql
security definer
set search_path = rentas, core, pg_temp
as $$
declare
  v_row rentas.break_glass_session;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'close_break_glass_session: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update rentas.break_glass_session
  set closed_at = now(), closed_by = p_caller_id
  where id = p_session_id and actor_user_id = p_caller_id and closed_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'sesión de romper-cristal no encontrada, ajena, o ya cerrada' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

revoke all on function rentas.close_break_glass_session(uuid, uuid) from public;
grant execute on function rentas.close_break_glass_session(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) rentas.list_reservas_for_break_glass -- la lectura de datos de tenant
--    real, gateada por una sesión de acceso VIGENTE (sección 1). Reemplaza,
--    como fuente de datos de
--    `PostgresBreakGlassRentasDataRepository.listReservasTenant` (@atiende/
--    domain-rentas), la lectura directa contra `rentas.ocupacion` que ese
--    archivo documentaba como dependiente de `ManagedPostgresEngine.admin`.
--
--    HALLAZGO verificado contra el código real antes de decidir este diseño
--    (no asumido): `admin` NO es `service_role` -- es el MISMO rol de mínimo
--    privilegio que `withAppSession` (ver el comentario de cabecera de
--    `packages/db/src/managed-postgres-engine.ts`, y la confirmación
--    explícita en `apps/api/src/production/deps.ts`: "la confirmación de que
--    engine.admin NO es service_role"). Solo `service_role` tiene
--    `bypassrls` en este monorepo, y este monorepo deliberadamente no lo
--    aprovisiona para `apps/api` (mismo criterio ya documentado por
--    `0010_platform_superadmin.sql`: "este monorepo no aprovisiona
--    service_role -- acceso exclusivamente vía la función security
--    definer"). Es decir: una lectura de `rentas.ocupacion` bajo `engine.admin`
--    sigue sujeta a las policies normales de esa tabla (solo staff con
--    membership real) y devolvería SIEMPRE cero filas para el propio
--    superadmin -- el mecanismo, tal como estaba diseñado en
--    `012_break_glass_audit.sql`, nunca podía funcionar contra Postgres real.
--    Mismo patrón de solución que `013_owner_portal_security_definer.sql` ya
--    estableció para el mismo tipo de gap (`rentas.owner_credential`, sin
--    GRANT a `authenticated`): una función `security definer`, dueña de su
--    propia autorización completa (identidad + rol + ventana vigente), sobre
--    la MISMA sesión por-request del superadmin -- nunca `engine.admin`.
create or replace function rentas.list_reservas_for_break_glass(p_caller_id uuid, p_organization_id uuid)
returns table (
  ocupacion_id uuid,
  property_id uuid,
  unidad_id uuid,
  check_in text,
  check_out text,
  estado text,
  huesped_nombre text,
  huesped_contacto text
)
language plpgsql
stable
security definer
set search_path = rentas, core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_reservas_for_break_glass: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from rentas.break_glass_session s
    where s.actor_user_id = p_caller_id
      and s.organization_id = p_organization_id
      and s.closed_at is null
      and s.expires_at > now()
  ) then
    raise exception 'sin acceso de romper-cristal activo y vigente para esta organización' using errcode = '42501';
  end if;

  return query
    select o.id, o.property_id, o.unidad_id,
           lower(o.rango)::text, upper(o.rango)::text,
           o.estado, g.nombre, g.contacto
    from rentas.ocupacion o
    left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
    where o.organization_id = p_organization_id and o.capa = 'reserva'
    order by lower(o.rango) desc;
end;
$$;

revoke all on function rentas.list_reservas_for_break_glass(uuid, uuid) from public;
grant execute on function rentas.list_reservas_for_break_glass(uuid, uuid) to authenticated;
