-- Fase 7 rentas -- mensajería con huésped: borrador de IA + aprobación humana
-- obligatoria (H-056 a H-061 del origen, ver packages/domain-rentas/src/mensajeria/*
-- y src/agentes/*). Requiere: 001_rentas_schema.sql ya aplicada (rentas.unidad,
-- rentas.guest_minimo, rentas.ocupacion, core.property/core.membership).
--
-- Tres tablas nuevas, mismo criterio de tenancy que 001 (property-scoped, RLS vía
-- core.has_property_access) + una cuarta a nivel de organización (plantillas, H-056:
-- una plantilla de mensajería es una decisión de negocio del tenant, no de una
-- property concreta -- mismo criterio que rentas.organization_perfil):
--
--   rentas.conversacion     -- hilo de mensajería con un huésped por unidad/canal.
--                              TOP-LEVEL (property_id directo), mismo criterio que
--                              rentas.reserva_financiero: aunque cuelga
--                              conceptualmente de unidad/ocupación, tener
--                              property_id propio evita un join extra en cada
--                              policy de RLS.
--   rentas.mensaje          -- mensajes entrantes/salientes de una conversación.
--                              Hija de conversacion (RLS vía join), mismo criterio
--                              que rentas.linea_gasto/rentas.linea_impuesto.
--   rentas.borrador_mensaje -- cola de aprobación humana (H-059): la transición
--                              pendiente_aprobacion -> enviado NUNCA ocurre sin que
--                              aprobado_por esté poblado -- la garantía real vive en
--                              @atiende/domain-rentas::mensajeria/colaAprobacion.ts
--                              (máquina de estados pura), esta tabla solo persiste
--                              transiciones ya validadas por ese código. Hija de
--                              conversacion (RLS vía join).
--   rentas.plantilla_mensaje -- plantillas por evento/idioma/canal (H-056),
--                              organization-scoped (nunca property-scoped: una
--                              plantilla de "confirmación" aplica a cualquier
--                              property del tenant).

-- ---------------------------------------------------------------------------
-- Conversación -- top-level, property-scoped.
-- ---------------------------------------------------------------------------
create table rentas.conversacion (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  -- Solo los 3 canales con mensajería real documentada (airbnb/vrbo/booking) --
  -- "manual" (rentas.canal) nunca es un canal de mensajería, ver
  -- domain-rentas/src/mensajeria/tipos.ts::CANALES_MENSAJERIA. Se guarda como texto
  -- (no FK a rentas.canal.id) a propósito: el motor de dominio trabaja con el
  -- código de canal como valor, nunca con un id de catálogo -- mismo criterio que
  -- borrador_mensaje.canal_codigo más abajo.
  canal_codigo text not null check (canal_codigo in ('airbnb', 'vrbo', 'booking')),
  ocupacion_id uuid references rentas.ocupacion(id) on delete set null,
  huesped_minimo_id uuid references rentas.guest_minimo(id) on delete set null,
  -- Contexto congelado al momento de crear la conversación -- ver comentario de
  -- ConversacionRecord en domain-rentas/src/mensajeria/types.ts: `ContextoBorrador`
  -- nunca se reconstruye a partir de un segundo join en el momento de generar un
  -- borrador, siempre desde estas columnas ya resueltas por el servidor.
  propiedad_nombre text not null,
  huesped_nombre text,
  fecha_check_in date,
  fecha_check_out date,
  reserva_confirmada boolean not null default false,
  creado_en timestamptz not null default now()
);
create index conversacion_property_idx on rentas.conversacion (property_id);
create index conversacion_unidad_idx on rentas.conversacion (unidad_id);

-- ---------------------------------------------------------------------------
-- Mensajes -- hija de conversacion.
-- ---------------------------------------------------------------------------
create table rentas.mensaje (
  id uuid primary key default gen_random_uuid(),
  conversacion_id uuid not null references rentas.conversacion(id) on delete cascade,
  direccion text not null check (direccion in ('entrante', 'saliente')),
  -- 'canal': llegó vía un adaptador real de canal (ninguno existe todavía en este
  -- monorepo). 'simulador': SimuladorCanalMensajeria (ver src/mensajeria/
  -- canalMensajeria.ts) -- el ÚNICO origen real hoy para un mensaje saliente.
  -- 'manual': un operador transcribe un mensaje recibido fuera de banda.
  origen text not null check (origen in ('canal', 'simulador', 'manual')),
  texto text not null,
  redactado boolean not null default false,
  creado_en timestamptz not null default now()
);
create index mensaje_conversacion_idx on rentas.mensaje (conversacion_id);

-- ---------------------------------------------------------------------------
-- Borrador de mensaje -- cola de aprobación humana (H-059, D-006). Hija de
-- conversacion.
-- ---------------------------------------------------------------------------
create table rentas.borrador_mensaje (
  id uuid primary key default gen_random_uuid(),
  conversacion_id uuid not null references rentas.conversacion(id) on delete cascade,
  mensaje_entrante_id uuid references rentas.mensaje(id) on delete set null,
  canal_codigo text not null check (canal_codigo in ('airbnb', 'vrbo', 'booking')),
  texto text not null,
  estado text not null default 'pendiente_aprobacion' check (estado in ('pendiente_aprobacion', 'aprobado', 'rechazado', 'enviado')),
  -- 'motor_borrador': GeneradorBorradorPlantillas (determinista, sin LLM).
  -- 'agente_llm': GeneradorBorradorIA (respaldado por @atiende/agent-core::LlmGateway).
  -- Ninguno de los dos puede, por construcción, dejar un borrador en otro estado que
  -- no sea 'pendiente_aprobacion' al insertarse -- ver el DEFAULT de arriba, sin
  -- excepción en el código de aplicación (mensajeria-borradores.ts nunca hace un
  -- INSERT con estado distinto).
  generado_por text not null check (generado_por in ('motor_borrador', 'agente_llm')),
  redactado boolean not null default false,
  aprobado_por uuid references core.staff_user(id) on delete set null,
  aprobado_en timestamptz,
  rechazado_por uuid references core.staff_user(id) on delete set null,
  rechazado_en timestamptz,
  motivo_rechazo text,
  mensaje_enviado_id uuid references rentas.mensaje(id) on delete set null,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  -- Espejo en SQL de la máquina de estados pura de colaAprobacion.ts -- defensa de
  -- última línea, nunca la única capa (la ruta HTTP ya valida la transición ANTES de
  -- este UPDATE): 'aprobado'/'enviado' exigen aprobado_por poblado; 'rechazado'
  -- exige rechazado_por + motivo_rechazo.
  constraint borrador_aprobado_exige_aprobador check (estado not in ('aprobado', 'enviado') or aprobado_por is not null),
  constraint borrador_enviado_exige_mensaje check (estado <> 'enviado' or mensaje_enviado_id is not null),
  constraint borrador_rechazado_exige_motivo check (estado <> 'rechazado' or (rechazado_por is not null and motivo_rechazo is not null))
);
create index borrador_mensaje_conversacion_idx on rentas.borrador_mensaje (conversacion_id);
create index borrador_mensaje_estado_idx on rentas.borrador_mensaje (estado) where estado = 'pendiente_aprobacion';

-- ---------------------------------------------------------------------------
-- Plantillas de mensajería (H-056) -- organization-scoped, nunca property-scoped.
-- ---------------------------------------------------------------------------
create table rentas.plantilla_mensaje (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  evento text not null check (evento in ('confirmacion', 'pre_llegada', 'check_in', 'check_out', 'resena')),
  idioma text not null check (idioma in ('es', 'en')),
  -- NULL = aplica a cualquier canal (ver PlantillaMensaje.canal en el dominio).
  canal_codigo text check (canal_codigo in ('airbnb', 'vrbo', 'booking')),
  cuerpo text not null,
  -- Default FALSE siempre -- crear una plantilla nunca la deja lista para
  -- programación automática sin un paso explícito de aprobación (H-056, ver
  -- domain-rentas/src/mensajeria/plantillas.ts::exigirPlantillaAprobadaParaProgramar
  -- y src/roles.ts::MENSAJERIA_PLANTILLA_APROBACION_ROLES).
  aprobada_por_tenant boolean not null default false,
  activa boolean not null default true,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index plantilla_mensaje_organization_idx on rentas.plantilla_mensaje (organization_id);

-- ---------------------------------------------------------------------------
-- RLS -- mismo criterio que 001_rentas_schema.sql: la autoridad de membership es
-- SIEMPRE core.membership vía core.has_property_access, nunca una tabla propia. El
-- filtrado FINO de rol (quién puede generar/aprobar/rechazar un borrador --
-- MENSAJERIA_ESCRITURA_ROLES) ocurre en apps/api (assertVerticalRole), mismo
-- criterio que reservas.ts/bloqueos.ts -- NO se embebe lógica de rol fino en la RLS
-- de esta tabla (a diferencia de rentas.can_read_finanzas/can_write_finanzas, que sí
-- lo hacen para dinero): mensajería no alcanza ese nivel de sensibilidad.
-- ---------------------------------------------------------------------------
alter table rentas.conversacion enable row level security;
alter table rentas.mensaje enable row level security;
alter table rentas.borrador_mensaje enable row level security;
alter table rentas.plantilla_mensaje enable row level security;

create policy "staff ve conversaciones de su property" on rentas.conversacion for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta conversaciones de su property" on rentas.conversacion for insert
  with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve mensajes de conversaciones de su property" on rentas.mensaje for select
  using (exists (select 1 from rentas.conversacion c where c.id = mensaje.conversacion_id and core.has_property_access(auth.uid(), c.property_id)));
create policy "staff inserta mensajes de conversaciones de su property" on rentas.mensaje for insert
  with check (exists (select 1 from rentas.conversacion c where c.id = mensaje.conversacion_id and core.has_property_access(auth.uid(), c.property_id)));

create policy "staff ve borradores de conversaciones de su property" on rentas.borrador_mensaje for select
  using (exists (select 1 from rentas.conversacion c where c.id = borrador_mensaje.conversacion_id and core.has_property_access(auth.uid(), c.property_id)));
create policy "staff inserta borradores de conversaciones de su property" on rentas.borrador_mensaje for insert
  with check (exists (select 1 from rentas.conversacion c where c.id = borrador_mensaje.conversacion_id and core.has_property_access(auth.uid(), c.property_id)));
create policy "staff actualiza borradores de conversaciones de su property" on rentas.borrador_mensaje for update
  using (exists (select 1 from rentas.conversacion c where c.id = borrador_mensaje.conversacion_id and core.has_property_access(auth.uid(), c.property_id)))
  with check (exists (select 1 from rentas.conversacion c where c.id = borrador_mensaje.conversacion_id and core.has_property_access(auth.uid(), c.property_id)));

create policy "staff ve plantillas de su organización" on rentas.plantilla_mensaje for select
  using (exists (select 1 from core.membership m where m.organization_id = plantilla_mensaje.organization_id and m.user_id = auth.uid()));
create policy "staff inserta plantillas de su organización" on rentas.plantilla_mensaje for insert
  with check (exists (select 1 from core.membership m where m.organization_id = plantilla_mensaje.organization_id and m.user_id = auth.uid()));
create policy "staff actualiza plantillas de su organización" on rentas.plantilla_mensaje for update
  using (exists (select 1 from core.membership m where m.organization_id = plantilla_mensaje.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = plantilla_mensaje.organization_id and m.user_id = auth.uid()));

revoke all on rentas.conversacion, rentas.mensaje, rentas.borrador_mensaje, rentas.plantilla_mensaje from public, anon;
grant select, insert on rentas.conversacion, rentas.mensaje to authenticated;
grant select, insert, update on rentas.borrador_mensaje, rentas.plantilla_mensaje to authenticated;
grant select, insert, update, delete on rentas.conversacion, rentas.mensaje, rentas.borrador_mensaje, rentas.plantilla_mensaje to service_role;
