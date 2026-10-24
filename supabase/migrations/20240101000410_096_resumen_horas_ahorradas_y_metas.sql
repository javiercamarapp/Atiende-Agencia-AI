-- Configuracion del Resumen por ORGANIZACION: minutos de atencion humana que ahorra cada conversacion atendida por el agente (base de «Horas de atencion
-- ahorradas») y las metas de adopcion de IA (% de pedidos y % de ingresos por agentes). Prefijo de supabase/migrations asignado: 20240101000410 (interno 096;
-- 094 y 095 estan reservados por otros carriles).
--
-- Decision de diseno: UNA tabla NUEVA, ninguna restriccion existente cambia, y NO hay funcion SECURITY DEFINER: la tabla es de configuracion por organizacion
-- y las policies de RLS bastan (menos superficie que un definer). El TypeScript que la lee degrada con SAVEPOINT a «sin configurar» cuando la base todavia no
-- la tiene (SQLSTATE 42P01/42703/42883): nada de esto se aplica al mergear, y sin esta migracion el Resumen dice «configuralo» en vez de inventar una cifra.
--
-- Justificacion de seguridad de cada GRANT / policy (una por una):
--
--  * RLS habilitado y `revoke all ... from public, anon`: `anon` no recibe NINGUN privilegio (ni lectura).
--  * SELECT para `authenticated` con la policy `auth.uid() is null or <miembro de la organizacion>`: el Resumen lo lee cualquier miembro con acceso al panel
--    (owner, admin, staff); la rama `auth.uid() is null` es la sesion de SISTEMA (reportes y rutinas sin usuario). La tabla no guarda PII ni texto libre:
--    solo tres numeros acotados; RLS aisla organizaciones.
--  * INSERT/UPDATE solo owner/admin de la organizacion, y `updated_by = auth.uid()` en el `with check`: nadie escribe configuracion a nombre de otro. El
--    `organization_id` se concede solo en INSERT (una fila no cambia de tenant) y la PK por organizacion impide duplicados.
--  * GRANT por COLUMNA: solo los tres ajustes, `updated_by` y `updated_at`. Sin DELETE para `authenticated`: para quitar un valor se guarda null (queda en
--    la bitacora de auditoria, que escribe la API con antes/despues).
--  * `service_role` conserva todos los privilegios (mantenimiento de plataforma), igual que el resto de las tablas del paquete.
--  * CHECK por columna: minutos 1..120 y metas 1..100; valores fuera de rango mueren en la base aunque alguien salte la validacion de la API.
-- REVERSA (manual, no se ejecuta sola): la migracion solo CREA una tabla nueva y nada mas la referencia, asi que deshacerla es borrarla. Las politicas,
-- los GRANT y los CHECK caen con ella:
--     drop table restaurantes.resumen_settings;
-- No hay funciones, tipos, indices ni secuencias aparte que limpiar. Se pierde la configuracion guardada (minutos y metas); el Resumen vuelve a decir
-- «configuralo» sin romperse, porque el TypeScript degrada a «sin configurar» cuando la tabla no existe (SQLSTATE 42P01).
create table restaurantes.resumen_settings (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  -- null = sin configurar: el Resumen no calcula horas ahorradas (muestra «configúralo»).
  minutos_por_conversacion smallint check (minutos_por_conversacion is null or minutos_por_conversacion between 1 and 120),
  -- null = sin meta: el tile no muestra «Tu meta».
  meta_pedidos_ia_pct smallint check (meta_pedidos_ia_pct is null or meta_pedidos_ia_pct between 1 and 100),
  meta_ingresos_ia_pct smallint check (meta_ingresos_ia_pct is null or meta_ingresos_ia_pct between 1 and 100),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table restaurantes.resumen_settings enable row level security;

create policy "miembros o sistema leen la configuracion del resumen" on restaurantes.resumen_settings for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = resumen_settings.organization_id and m.user_id = auth.uid()
    )
  );

create policy "owner/admin crea la configuracion del resumen de su organizacion" on restaurantes.resumen_settings for insert
  with check (
    updated_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = resumen_settings.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin actualiza la configuracion del resumen de su organizacion" on restaurantes.resumen_settings for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = resumen_settings.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    updated_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = resumen_settings.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.resumen_settings from public, anon;
grant select on restaurantes.resumen_settings to authenticated;
grant insert (organization_id, minutos_por_conversacion, meta_pedidos_ia_pct, meta_ingresos_ia_pct, updated_by, updated_at)
  on restaurantes.resumen_settings to authenticated;
grant update (minutos_por_conversacion, meta_pedidos_ia_pct, meta_ingresos_ia_pct, updated_by, updated_at)
  on restaurantes.resumen_settings to authenticated;
grant select, insert, update, delete on restaurantes.resumen_settings to service_role;
