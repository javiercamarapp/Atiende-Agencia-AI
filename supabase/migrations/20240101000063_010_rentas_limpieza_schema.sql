-- Fase 8 rentas -- módulo operativo de limpieza/mantenimiento (H-049 a H-055 del
-- origen, BACKLOG E08, REQ-111..120), ver packages/domain-rentas/src/limpieza/* y
-- src/limpieza/aplicacion/tareas.ts. Requiere: 001_rentas_schema.sql ya aplicada
-- (rentas.unidad, rentas.ocupacion, rentas.property_config, core.property/
-- core.membership/core.staff_user).
--
-- Cierra el gap identificado por auditoría: "limpieza" existía en 001 ÚNICAMENTE
-- como valor del enum `razon` de rentas.ocupacion (BUFFER_LIMPIEZA) -- ningún módulo
-- creaba tareas, checklists, inventario ni incidencias todavía.
--
-- Seis piezas nuevas:
--
--   rentas.property_config       -- (ALTER, no CREATE) 3 columnas nuevas: buffer de
--                                    limpieza (noches) + SLA internos por tipo de
--                                    tarea (horas). Se reutiliza la fila de
--                                    configuración por property que ya existe desde
--                                    001 -- NUNCA una tabla `configuracion_operativa_
--                                    propiedad` propia (el origen sí tenía una,
--                                    porque no existía ya una fila de config por
--                                    property en su esquema).
--   rentas.tarea_operativa       -- tarea de limpieza/mantenimiento/inspección.
--                                    TOP-LEVEL (property_id directo), mismo criterio
--                                    que rentas.conversacion (009): evita un join
--                                    extra en cada policy de RLS.
--   rentas.checklist_item_tarea  -- ítems del checklist de una tarea (H-051). Hija
--                                    de tarea_operativa, RLS vía join.
--   rentas.foto_checklist_item   -- fotos/timestamp de un ítem de checklist (H-051).
--                                    Hija de checklist_item_tarea, RLS vía join
--                                    encadenado. `etiqueta` fijo a 'dev-local' --
--                                    mismo criterio que citas/appointment_audit_events
--                                    y el resto del monorepo: NUNCA "producción" hoy,
--                                    todo almacenamiento de archivos sigue siendo
--                                    local de desarrollo, etiquetado explícito.
--   rentas.item_inventario       -- inventario de ropa blanca/consumibles por unidad
--                                    (H-052). TOP-LEVEL (property_id directo, mismo
--                                    criterio que tarea_operativa).
--   rentas.movimiento_inventario -- historial de consumo de inventario (H-052). Hija
--                                    de item_inventario, RLS vía join.
--   rentas.incidencia_mantenimiento -- incidencia reportada sobre una unidad (H-055),
--                                    con propuesta de bloqueo opcional que exige
--                                    confirmación humana explícita para volverse un
--                                    bloqueo real de calendario (REQ-118, D-011:
--                                    nunca cancela ni toca una reserva existente).
--                                    TOP-LEVEL (property_id directo).
--   rentas.notificacion_tarea    -- rastro de notificación al asignar/completar una
--                                    tarea (best-effort, sin canal real todavía --
--                                    mismo estado que citas antes de messaging_outbox
--                                    fuera de fase para este lote). Hija de
--                                    tarea_operativa, RLS vía join.

-- ---------------------------------------------------------------------------
-- Configuración operativa por property (H-050, H-054) -- 3 columnas nuevas sobre la
-- fila de configuración de property que ya existe desde 001_rentas_schema.sql.
-- ---------------------------------------------------------------------------
alter table rentas.property_config
  add column buffer_limpieza_noches integer not null default 1 check (buffer_limpieza_noches >= 0),
  add column sla_limpieza_horas integer not null default 4 check (sla_limpieza_horas > 0),
  add column sla_mantenimiento_horas integer not null default 24 check (sla_mantenimiento_horas > 0);

-- ---------------------------------------------------------------------------
-- Tarea operativa (limpieza/mantenimiento/inspección) -- top-level, property-scoped.
-- ---------------------------------------------------------------------------
create table rentas.tarea_operativa (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  -- Reserva (capa='reserva') que originó la tarea al confirmarse su checkout -- NULL
  -- para tareas creadas manualmente (mantenimiento/inspección ad-hoc).
  ocupacion_unidad_id uuid references rentas.ocupacion(id) on delete set null,
  tipo text not null check (tipo in ('limpieza', 'mantenimiento', 'inspeccion')),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'asignada', 'en_progreso', 'completada', 'bloqueada', 'cancelada')),
  prioridad text not null default 'media' check (prioridad in ('baja', 'media', 'alta', 'urgente')),
  asignado_a uuid references core.staff_user(id) on delete set null,
  es_proveedor_externo boolean not null default false,
  programada_para date not null,
  sla_vence_en timestamptz,
  -- Bloqueo `BUFFER_LIMPIEZA` de calendario asociado (H-050) -- NULL si la property
  -- no tiene buffer configurado (>0 noches) o si la tarea nunca lo tuvo.
  buffer_ocupacion_id uuid references rentas.ocupacion(id) on delete set null,
  completada_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index tarea_operativa_property_idx on rentas.tarea_operativa (property_id);
create index tarea_operativa_unidad_idx on rentas.tarea_operativa (unidad_id);
-- `procesarCheckoutsPendientes`/`reprogramarTareaPorCambioReserva`/
-- `cancelarTareaPorCancelacionReserva` (src/limpieza/aplicacion/tareas.ts) siempre
-- buscan por `ocupacion_unidad_id` -- índice parcial (solo filas con reserva de
-- origen, la mayoría de mantenimiento/inspección la tienen NULL).
create index tarea_operativa_ocupacion_idx on rentas.tarea_operativa (ocupacion_unidad_id) where ocupacion_unidad_id is not null;
create index tarea_operativa_sla_pendiente_idx on rentas.tarea_operativa (sla_vence_en) where estado not in ('completada', 'cancelada');

-- ---------------------------------------------------------------------------
-- Checklist -- hija de tarea_operativa.
-- ---------------------------------------------------------------------------
create table rentas.checklist_item_tarea (
  id uuid primary key default gen_random_uuid(),
  tarea_id uuid not null references rentas.tarea_operativa(id) on delete cascade,
  descripcion text not null,
  orden integer not null default 0,
  completado boolean not null default false,
  completado_en timestamptz,
  completado_por uuid references core.staff_user(id) on delete set null
);
create index checklist_item_tarea_tarea_idx on rentas.checklist_item_tarea (tarea_id);

-- ---------------------------------------------------------------------------
-- Fotos de checklist -- hija de checklist_item_tarea.
-- ---------------------------------------------------------------------------
create table rentas.foto_checklist_item (
  id uuid primary key default gen_random_uuid(),
  checklist_item_id uuid not null references rentas.checklist_item_tarea(id) on delete cascade,
  ruta_almacenamiento text not null,
  -- Nunca "producción" en esta fase: todo almacenamiento hoy es local de desarrollo,
  -- etiquetado explícitamente (regla de oro DEFINICION-DE-HECHO, aplicada aquí
  -- también a metadatos de archivos, no solo a canales de mensajería).
  etiqueta text not null default 'dev-local' check (etiqueta = 'dev-local'),
  subida_por uuid references core.staff_user(id) on delete set null,
  tomada_en timestamptz not null default now()
);
create index foto_checklist_item_checklist_idx on rentas.foto_checklist_item (checklist_item_id);

-- ---------------------------------------------------------------------------
-- Inventario de ropa blanca/consumibles por unidad (H-052) -- top-level,
-- property-scoped.
-- ---------------------------------------------------------------------------
create table rentas.item_inventario (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  nombre text not null,
  categoria text not null check (categoria in ('ropa_blanca', 'consumible', 'otro')),
  cantidad_actual numeric not null default 0 check (cantidad_actual >= 0),
  umbral_minimo numeric not null default 0 check (umbral_minimo >= 0),
  unidad_medida text not null default 'unidad',
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index item_inventario_property_idx on rentas.item_inventario (property_id);
create index item_inventario_unidad_idx on rentas.item_inventario (unidad_id);

-- ---------------------------------------------------------------------------
-- Movimientos de inventario -- hija de item_inventario.
-- ---------------------------------------------------------------------------
create table rentas.movimiento_inventario (
  id uuid primary key default gen_random_uuid(),
  item_inventario_id uuid not null references rentas.item_inventario(id) on delete cascade,
  tarea_id uuid references rentas.tarea_operativa(id) on delete set null,
  -- Negativo = consumo, positivo = reabastecimiento (el único motivo emitido hoy por
  -- src/limpieza/aplicacion/tareas.ts es 'consumo_checklist', negativo -- un endpoint
  -- de reabastecimiento manual queda fuera de fase, ver README de este paquete).
  cantidad numeric not null,
  motivo text not null default 'consumo_checklist',
  creado_en timestamptz not null default now()
);
create index movimiento_inventario_item_idx on rentas.movimiento_inventario (item_inventario_id);

-- ---------------------------------------------------------------------------
-- Incidencias de mantenimiento (H-055) -- top-level, property-scoped.
-- ---------------------------------------------------------------------------
create table rentas.incidencia_mantenimiento (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  tarea_origen_id uuid references rentas.tarea_operativa(id) on delete set null,
  severidad text not null check (severidad in ('leve', 'moderada', 'grave')),
  titulo text not null,
  descripcion text,
  estado text not null default 'abierta' check (estado in ('abierta', 'en_revision', 'bloqueo_propuesto', 'bloqueo_confirmado', 'resuelta', 'descartada')),
  -- Propuesta de bloqueo [inicio, fin) -- dos columnas `date` en vez de un
  -- `daterange` único: esta tabla nunca participa de ningún EXCLUDE de Postgres (a
  -- diferencia de rentas.ocupacion), así que no hay ninguna razón operativa para
  -- pagar la complejidad de parsear un daterange en la capa de aplicación.
  propuesta_bloqueo_inicio date,
  propuesta_bloqueo_fin date,
  -- Bloqueo `MANTENIMIENTO` real de calendario, solo tras confirmación humana
  -- explícita (H-055, REQ-118) -- NUNCA poblado por ningún trigger automático.
  bloqueo_ocupacion_id uuid references rentas.ocupacion(id) on delete set null,
  reportado_por uuid references core.staff_user(id) on delete set null,
  confirmado_por uuid references core.staff_user(id) on delete set null,
  confirmado_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  constraint incidencia_propuesta_bloqueo_rango_valido check (
    (propuesta_bloqueo_inicio is null and propuesta_bloqueo_fin is null)
    or (propuesta_bloqueo_inicio is not null and propuesta_bloqueo_fin is not null and propuesta_bloqueo_fin > propuesta_bloqueo_inicio)
  ),
  -- Espejo en SQL de requiereConfirmacionHumanaParaBloqueo() (src/limpieza/
  -- incidencias.ts) -- defensa de última línea, nunca la única capa: solo una
  -- incidencia 'grave' puede estar en 'bloqueo_propuesto'/'bloqueo_confirmado'.
  constraint incidencia_bloqueo_exige_severidad_grave check (estado not in ('bloqueo_propuesto', 'bloqueo_confirmado') or severidad = 'grave'),
  constraint incidencia_bloqueo_confirmado_exige_datos check (estado <> 'bloqueo_confirmado' or (bloqueo_ocupacion_id is not null and confirmado_por is not null))
);
create index incidencia_mantenimiento_property_idx on rentas.incidencia_mantenimiento (property_id);
create index incidencia_mantenimiento_unidad_idx on rentas.incidencia_mantenimiento (unidad_id);
create index incidencia_mantenimiento_bloqueo_propuesto_idx on rentas.incidencia_mantenimiento (creado_en) where estado = 'bloqueo_propuesto';

-- ---------------------------------------------------------------------------
-- Notificaciones de tarea (best-effort, rastro de auditoría) -- hija de
-- tarea_operativa. Sin canal real todavía (mismo estado que el resto del monorepo
-- antes de tener un dispatcher propio para este lote) -- `canales` queda vacío por
-- defecto, poblarlo con un canal real queda fuera de fase.
-- ---------------------------------------------------------------------------
create table rentas.notificacion_tarea (
  id uuid primary key default gen_random_uuid(),
  tarea_id uuid not null references rentas.tarea_operativa(id) on delete cascade,
  evento text not null check (evento in ('asignada', 'completada')),
  canales text[] not null default '{}',
  creado_en timestamptz not null default now()
);
create index notificacion_tarea_tarea_idx on rentas.notificacion_tarea (tarea_id);

-- ---------------------------------------------------------------------------
-- RLS -- mismo criterio que 001/009: la autoridad de membership es SIEMPRE
-- core.membership vía core.has_property_access, nunca una tabla propia. El
-- filtrado FINO de rol (LIMPIEZA_OPERACION_ROLES/LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES)
-- ocurre en apps/api (assertVerticalRole), nunca embebido en esta RLS.
-- ---------------------------------------------------------------------------
alter table rentas.tarea_operativa enable row level security;
alter table rentas.checklist_item_tarea enable row level security;
alter table rentas.foto_checklist_item enable row level security;
alter table rentas.item_inventario enable row level security;
alter table rentas.movimiento_inventario enable row level security;
alter table rentas.incidencia_mantenimiento enable row level security;
alter table rentas.notificacion_tarea enable row level security;

create policy "staff ve tareas de su property" on rentas.tarea_operativa for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta tareas de su property" on rentas.tarea_operativa for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza tareas de su property" on rentas.tarea_operativa for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve checklist de tareas de su property" on rentas.checklist_item_tarea for select
  using (exists (select 1 from rentas.tarea_operativa t where t.id = checklist_item_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id)));
create policy "staff inserta checklist de tareas de su property" on rentas.checklist_item_tarea for insert
  with check (exists (select 1 from rentas.tarea_operativa t where t.id = checklist_item_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id)));
create policy "staff actualiza checklist de tareas de su property" on rentas.checklist_item_tarea for update
  using (exists (select 1 from rentas.tarea_operativa t where t.id = checklist_item_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id)))
  with check (exists (select 1 from rentas.tarea_operativa t where t.id = checklist_item_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id)));

create policy "staff ve fotos de checklist de su property" on rentas.foto_checklist_item for select
  using (exists (select 1 from rentas.checklist_item_tarea ci join rentas.tarea_operativa t on t.id = ci.tarea_id where ci.id = foto_checklist_item.checklist_item_id and core.has_property_access(auth.uid(), t.property_id)));
create policy "staff inserta fotos de checklist de su property" on rentas.foto_checklist_item for insert
  with check (exists (select 1 from rentas.checklist_item_tarea ci join rentas.tarea_operativa t on t.id = ci.tarea_id where ci.id = foto_checklist_item.checklist_item_id and core.has_property_access(auth.uid(), t.property_id)));

create policy "staff ve inventario de su property" on rentas.item_inventario for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta inventario de su property" on rentas.item_inventario for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza inventario de su property" on rentas.item_inventario for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve movimientos de inventario de su property" on rentas.movimiento_inventario for select
  using (exists (select 1 from rentas.item_inventario i where i.id = movimiento_inventario.item_inventario_id and core.has_property_access(auth.uid(), i.property_id)));
create policy "staff inserta movimientos de inventario de su property" on rentas.movimiento_inventario for insert
  with check (exists (select 1 from rentas.item_inventario i where i.id = movimiento_inventario.item_inventario_id and core.has_property_access(auth.uid(), i.property_id)));

create policy "staff ve incidencias de su property" on rentas.incidencia_mantenimiento for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta incidencias de su property" on rentas.incidencia_mantenimiento for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza incidencias de su property" on rentas.incidencia_mantenimiento for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve notificaciones de tareas de su property" on rentas.notificacion_tarea for select
  using (exists (select 1 from rentas.tarea_operativa t where t.id = notificacion_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id)));
create policy "staff inserta notificaciones de tareas de su property" on rentas.notificacion_tarea for insert
  with check (exists (select 1 from rentas.tarea_operativa t where t.id = notificacion_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id)));

revoke all on rentas.tarea_operativa, rentas.checklist_item_tarea, rentas.foto_checklist_item, rentas.item_inventario, rentas.movimiento_inventario, rentas.incidencia_mantenimiento, rentas.notificacion_tarea from public, anon;
grant select, insert, update on rentas.tarea_operativa, rentas.checklist_item_tarea, rentas.item_inventario, rentas.incidencia_mantenimiento to authenticated;
grant select, insert on rentas.foto_checklist_item, rentas.movimiento_inventario, rentas.notificacion_tarea to authenticated;
grant select, insert, update, delete on rentas.tarea_operativa, rentas.checklist_item_tarea, rentas.foto_checklist_item, rentas.item_inventario, rentas.movimiento_inventario, rentas.incidencia_mantenimiento, rentas.notificacion_tarea to service_role;
