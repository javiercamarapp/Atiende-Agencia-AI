-- FASE 3 (producto) — la vertical RESTAURANTES no tiene bitácora de auditoría
-- PROPIA de las acciones del staff (rentas ya la tiene, ver
-- packages/domain-rentas/migrations/021_rentas_audit_log.sql +
-- 022_rentas_audit_log_orden_determinista.sql). Este archivo COPIA ese patrón ya
-- probado en `main` (PR #165/#173) y nace YA con las dos correcciones que a rentas
-- le costaron una segunda migración/una ronda de revisión, en vez de repetir el
-- mismo camino:
--
--   1. Orden TOTAL desde el día uno — `seq bigint generated always as identity`
--      vive en ESTA migración (rentas la agregó recién en el PR #173, r6, porque
--      `created_at default now()` es CONSTANTE dentro de una transacción de
--      Postgres — ver "Date/Time Functions and Operators" en la documentación
--      oficial — y dos filas de la MISMA transacción pueden empatar; sin una
--      columna de desempate único, `order by created_at desc` no es un orden
--      total y la paginación por OFFSET sobre ese empate es INESTABLE: una fila
--      puede repetirse o desaparecer entre dos páginas). Aquí los 2 índices ya se
--      crean con `(..., created_at desc, seq desc)` desde el principio — nunca
--      hace falta un `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS
--      IDENTITY` sobre una tabla con filas reales.
--   2. `record_audit_log` valida ROL, no solo membership — la revisión de rentas
--      (r5, no bloqueante #9) señaló que `rentas.record_audit_log` solo exige que
--      el actor pertenezca a la organización, sin validar su `vertical_role`: un
--      staff de bajo privilegio con SQL directo podría sembrar filas arbitrarias.
--      Ahí no se corrigió porque ningún caller real lo necesitaba todavía. Aquí sí
--      se puede hacer bien desde el día uno: la función exige `vertical_role in
--      ('owner','admin','staff')` (== `MANAGER_ROLES` de
--      packages/domain-restaurantes/src/roles.ts — el mismo techo que ya protege
--      TODAS las rutas que llaman a esta función: admin-catalog.ts/
--      admin-promotions.ts/admin-orders.ts/admin-staff.ts, ver `assertVerticalRole`
--      en cada una) — nunca `repartidor` (rol disjunto de MANAGER_ROLES, ver el
--      comentario de cabecera de roles.ts).
--
-- Patrón copiado literal de rentas en todo lo demás:
--   - Tabla mínima append-only (organización/actor/acción/cuándo indexados, resto
--     en `campo`/`antes`/`despues`, texto corto y acotado -- NUNCA una fila
--     completa ni un jsonb crudo, NUNCA PII de comensales/teléfonos completos/
--     secretos: solo actor, acción, entidad, ids y un resumen mínimo).
--   - RLS de solo-lectura para un rol restringido (aquí `owner`/`admin` — ver
--     apps/api/src/routes/verticals/restaurantes/auditoria.ts —, más estricto
--     todavía que `admin_gestora` de rentas por instrucción explícita de esta
--     fase: "lectura ... solo para owner/admin de la organización").
--   - Deny-by-default de INSERT (sin policy para `authenticated`) — escritura
--     EXCLUSIVA vía `restaurantes.record_audit_log()`, `security definer` con
--     `search_path` fijo y `revoke` de `public`.
--   - Triggers de bloqueo incondicional de UPDATE/DELETE (defensa en profundidad
--     más allá de la ausencia de GRANT) — ni `service_role` puede.
--   - `on delete restrict` (nunca `cascade`) en las dos FK: el trigger de bloqueo
--     de DELETE de abajo rechaza CUALQUIER DELETE sobre esta tabla, incluido el
--     que un `cascade` dispararía al borrar la organización/el staff_user —
--     `restrict` expresa exactamente lo mismo (ese borrado falla mientras existan
--     filas de bitácora) sin prometer un cascade que el propio trigger nunca deja
--     completar.
--   - `left(..., N)` DENTRO de la función (nunca solo en TypeScript) — la ÚNICA
--     vía de escritura es esta función, así que es el único lugar donde puede
--     garantizarse, para TODO caller presente y futuro, que el CHECK de longitud
--     de la tabla (200/500/500) nunca se viola. Rentas lo agregó recién en
--     revisión (r5, bloqueante 1: un `motivoVersion` largo hacía que la fila de
--     `owner_statement` se perdiera en silencio); aquí nace así.
--   - `service_role` NO recibe `insert` (mismo criterio que la corrección de
--     revisión de rentas): `security definer` corre con los privilegios del DUEÑO
--     de la función, ningún GRANT de INSERT sobre la TABLA es necesario, y
--     `service_role` tiene `bypassrls` — un GRANT de INSERT ahí sería una vía de
--     escritura DIRECTA con actor arbitrario que ningún caller real usa hoy.
--
-- Deliberadamente SIN variante de solo-sistema (`auth.uid() is null`): las 5
-- acciones sensibles reales que esta fase instrumenta (ver comentario de
-- apps/api/src/routes/verticals/restaurantes/auditoria.ts para el detalle
-- completo por ruta) SIEMPRE corren en la sesión de STAFF autenticado
-- (`dbSession(deps.engine)` -> `ManagedPostgresEngine.withAppSession({userId:
-- <el staff real>}, ...)`, ver admin-catalog.ts/admin-promotions.ts/
-- admin-orders.ts/admin-staff.ts) — verificado contra el código real antes de
-- escribir esta migración (`apps/worker/src/jobs/restaurantes/README.md`: "sin
-- código propio en apps/worker", ningún cron toca precios/promociones/staff de
-- restaurantes), nunca desde la sesión de sistema. Si algún caller de sistema
-- llega a necesitarlo más adelante (p. ej. un cron que cancele pedidos vencidos),
-- se agrega entonces una variante `restaurantes.record_audit_log_sistema(...)`
-- con `auth.uid() is null` explícito — no se inventa aquí sin un caller real.
--
-- Requiere: 0001_core_schema.sql (core.organization, core.staff_user,
-- core.membership) y 001_restaurantes_schema.sql (restaurantes.*).

-- ---------------------------------------------------------------------------
-- 1) restaurantes.audit_log -- tabla mínima, append-only, orden total desde el
--    día uno.
-- ---------------------------------------------------------------------------
create table restaurantes.audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  actor_user_id uuid not null references core.staff_user(id) on delete restrict,
  -- Ej.: 'producto.precio_actualizado', 'promocion.creada', 'pedido.cancelado',
  -- 'repartidor.asignado', 'staff.invitado' -- texto libre corto (no un enum):
  -- nuevas acciones dentro de un `entity_type` ya cubierto no requieren otra
  -- migración, mismo criterio que `action text` en despachos.audit_log/
  -- rentas.audit_log.
  action text not null check (char_length(btrim(action)) between 1 and 200),
  -- Catálogo CERRADO -- necesario para el filtro por tipo de la pantalla de
  -- auditoría (`GET .../admin/auditoria?tipo=...`). 'configuracion' queda
  -- reservado sin caller todavía -- verificado contra el código real antes de
  -- construir nada: hoy NINGUNA ruta de restaurantes permite editar
  -- WhatsApp/voz/horarios/zonas de entrega (ver conocidos de la fase en el
  -- cuerpo del PR) -- el día que esa ruta se construya, debe llamar a
  -- `restaurantes.record_audit_log(...)` con `entity_type = 'configuracion'`.
  entity_type text not null check (entity_type in ('producto', 'promocion', 'pedido', 'repartidor', 'staff', 'configuracion')),
  -- Nulable: no toda acción tiene un id de entidad único y estable (ej. cambiar
  -- el rol de un staff identifica al staff por su propio id de usuario, ya
  -- capturado en `campo`/`despues`; una invitación revocada si tiene un id de
  -- invitación real).
  entity_id uuid,
  -- Resumen del cambio -- NUNCA una fila completa ni un jsonb crudo, NUNCA PII de
  -- comensales/teléfonos completos/secretos (mandato explícito de esta fase):
  -- qué campo cambió, su valor antes y después, ambos ya resumidos por el
  -- caller.
  campo text check (campo is null or char_length(campo) <= 200),
  antes text check (antes is null or char_length(antes) <= 500),
  despues text check (despues is null or char_length(despues) <= 500),
  created_at timestamptz not null default now(),
  -- Orden TOTAL desde el día uno (ver comentario de cabecera, punto 1) -- nunca
  -- hace falta una migración de corrección como la 022 de rentas.
  seq bigint generated always as identity
);

-- `GET .../admin/auditoria` (paginado, más reciente primero) es el patrón de
-- acceso principal -- mismo índice que rentas.audit_log/despachos.audit_log. El
-- segundo índice sirve el filtro por tipo de acción de esa misma ruta. Ambos ya
-- incluyen `seq desc` como desempate (ver punto 1 del comentario de cabecera).
create index restaurantes_audit_log_org_created_idx on restaurantes.audit_log (organization_id, created_at desc, seq desc);
create index restaurantes_audit_log_org_type_created_idx on restaurantes.audit_log (organization_id, entity_type, created_at desc, seq desc);

alter table restaurantes.audit_log enable row level security;

-- Lectura: SOLO owner/admin de la organización -- mandato explícito de esta fase
-- ("lectura ... solo para owner/admin de la organización"), más estricto que
-- rentas.audit_log (que admite cualquier `admin_gestora`, el único rol de esa
-- vertical con ese alcance) porque restaurantes SÍ tiene un rol "staff" de
-- gestión (`MANAGER_ROLES` incluye "staff") que NO debe ver qué hizo cada
-- compañero.
create policy "owner/admin lee la bitacora de auditoria de su organizacion" on restaurantes.audit_log for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = audit_log.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

-- Escritura: SOLO vía `restaurantes.record_audit_log()` (abajo) -- deliberadamente
-- SIN policy de INSERT para `authenticated` (deny-by-default real, mismo criterio
-- que rentas.audit_log/despachos.audit_log/hoteles.fraude_audit_log): ni siquiera
-- un bug futuro que arme un INSERT a mano contra esta tabla podría escribir aquí
-- sin pasar por la función `security definer`.
--
-- "Sin UPDATE ni DELETE para NADIE" (mandato explícito de esta fase) -- ni
-- siquiera `service_role` recibe esos GRANT (mismo criterio que
-- rentas.audit_log), Y ADEMÁS se agregan triggers de bloqueo incondicional como
-- defensa en profundidad: ni un GRANT futuro accidental podría violar el
-- append-only.
--
-- `service_role` NO recibe `insert` (mismo criterio que la corrección de
-- revisión de rentas, ver comentario de cabecera): `security definer` hace que
-- `record_audit_log` corra con los privilegios de su DUEÑO, ningún GRANT de
-- INSERT sobre la TABLA es necesario, y `service_role` tiene `bypassrls` -- un
-- GRANT de INSERT aquí sería una vía de escritura DIRECTA con actor arbitrario
-- que ningún caller real usa hoy. Solo `select` (necesario para que un job de
-- plataforma pueda leer, igual que `authenticated`).
revoke all on restaurantes.audit_log from public, anon, authenticated, service_role;
grant select on restaurantes.audit_log to authenticated, service_role;

create or replace function restaurantes.audit_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'restaurantes_audit_log_append_only: % no está permitido sobre restaurantes.audit_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger restaurantes_audit_log_block_update_trg
  before update on restaurantes.audit_log
  for each row execute function restaurantes.audit_log_block_mutation();
create trigger restaurantes_audit_log_block_delete_trg
  before delete on restaurantes.audit_log
  for each row execute function restaurantes.audit_log_block_mutation();

-- ---------------------------------------------------------------------------
-- 2) restaurantes.record_audit_log -- ÚNICA vía de escritura. El actor SIEMPRE
--    sale de `auth.uid()` (nunca de un parámetro que el código de aplicación
--    pudiera equivocar o un bug futuro pudiera falsificar) -- `security definer`
--    con `search_path` fijo (nunca resuelve un objeto de un schema que el caller
--    pudiera controlar) y `revoke` de `public` (solo `authenticated` puede
--    ejecutarla).
--
--    Defensa en profundidad DOBLE (más estricta que rentas.record_audit_log,
--    ver el punto 2 del comentario de cabecera):
--      a) el actor pertenece a `p_organization_id` -- sin este check, cualquier
--         staff autenticado de CUALQUIER organización podría sembrar filas de
--         auditoría falsas en la bitácora de un tenant ajeno (`security
--         definer` bypassa la policy de SELECT de arriba para el INSERT).
--      b) el `vertical_role` del actor en esa organización es uno de
--         'owner'/'admin'/'staff' (== MANAGER_ROLES) -- el mismo techo que YA
--         protege, en TypeScript, cada ruta que llama a esta función
--         (`assertVerticalRole(c, MANAGER_ROLES)` en admin-catalog.ts/
--         admin-promotions.ts/admin-orders.ts; `assertVerticalRole(c,
--         STAFF_INVITE_ROLES)` -- subconjunto de MANAGER_ROLES -- en
--         admin-staff.ts). Sin este segundo check, un "repartidor" con SQL
--         directo (o un bug futuro en el primer filtro de TypeScript) podría
--         sembrar filas de auditoría arbitrarias a su propio nombre.
--
--    Truncamiento defensivo de `p_campo`/`p_antes`/`p_despues` con `left(...)`
--    DESDE EL DÍA UNO (rentas lo agregó recién en revisión, r5 bloqueante 1):
--    esta función es la ÚNICA vía de escritura -- por eso es el único lugar
--    donde puede garantizarse, para TODO caller presente y futuro, que el CHECK
--    de longitud de la tabla (200/500/500) nunca se viola. `left(..., N)` nunca
--    falla sobre NULL (devuelve NULL).
-- ---------------------------------------------------------------------------
create or replace function restaurantes.record_audit_log(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_campo text,
  p_antes text,
  p_despues text
)
returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_vertical_role text;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'restaurantes.record_audit_log: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;

  select m.vertical_role into v_vertical_role
  from core.membership m
  where m.organization_id = p_organization_id and m.user_id = v_actor;

  if v_vertical_role is null then
    raise exception 'restaurantes.record_audit_log: el actor % no pertenece a la organizacion %.', v_actor, p_organization_id
      using errcode = '42501';
  end if;

  if v_vertical_role not in ('owner', 'admin', 'staff') then
    raise exception 'restaurantes.record_audit_log: el rol % del actor % no puede escribir en la bitacora de auditoria.', v_vertical_role, v_actor
      using errcode = '42501';
  end if;

  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, v_actor, p_action, p_entity_type, p_entity_id, left(p_campo, 200), left(p_antes, 500), left(p_despues, 500))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function restaurantes.record_audit_log(uuid, text, text, uuid, text, text, text) from public;
-- Mismo rol bajo el que corre TODO este archivo vía `ManagedPostgresEngine.
-- withAppSession` (siempre `set local role authenticated`) -- nunca `anon`, este
-- monorepo no usa ese rol.
grant execute on function restaurantes.record_audit_log(uuid, text, text, uuid, text, text, text) to authenticated;
