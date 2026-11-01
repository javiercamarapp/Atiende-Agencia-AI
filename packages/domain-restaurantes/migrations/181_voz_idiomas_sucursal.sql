-- F4c (paridad menor) -- SELECTOR DE IDIOMAS del agente de VOZ por sucursal. Prefijo de supabase/migrations asignado: 20240101000481 (interno 181).
--
-- Decision de diseno: tabla NUEVA e independiente de `branch_voice_config` (025), para no tocar el tipo `VozConfig` compartido con otros verticales ni sus GRANT por columna.
-- SIN fila (o con la fila por omision) la sucursal habla solo es-MX y la instruccion de la llamada queda BYTE A BYTE igual que antes: el TypeScript agrega el bloque de idiomas
-- unicamente cuando hay mas de un idioma o la deteccion automatica esta encendida. La lista de idiomas permitidos vive en el codigo (versionada); aqui solo se acota el FORMATO
-- del codigo (BCP-47 corto) y la cantidad, asi que un idioma nuevo no exige migracion.
--
-- Justificacion de seguridad (una por una):
--  * RLS habilitado y `revoke all ... from public, anon`: `anon` no recibe NINGUN privilegio.
--  * SELECT para `authenticated` con la policy `auth.uid() is null or owner/admin de la organizacion`: la rama `auth.uid() is null` es la sesion de SISTEMA (el servicio de llamadas
--    arma la instruccion sin usuario), mismo escape que `branch_voice_config` (025). La tabla no guarda PII, secretos ni texto libre: solo codigos de idioma de una lista cerrada.
--  * INSERT/UPDATE solo owner/admin de la organizacion, con `updated_by = auth.uid()` en el `with check` (nadie escribe a nombre de otro) y la sucursal debe pertenecer a la misma
--    organizacion (cross-tenant bloqueado). Sin DELETE para `authenticated`: volver al comportamiento de siempre = guardar es-MX sin adicionales.
--  * GRANT por COLUMNA: `organization_id` y `property_id` solo en INSERT (una fila no cambia de tenant ni de sucursal).
--  * CHECK por columna: formato del codigo, maximo 4 adicionales y sin repetir el principal; valores invalidos mueren en la base aunque alguien salte la validacion de la API.
create table restaurantes.branch_voice_languages (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  idioma_principal text not null default 'es-MX' check (idioma_principal ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  idiomas_adicionales text[] not null default '{}'
    check (cardinality(idiomas_adicionales) <= 4 and array_to_string(idiomas_adicionales, ',') ~ '^([a-z]{2,3}(-[A-Z]{2})?(,|$))*$' and not (idioma_principal = any (idiomas_adicionales))),
  deteccion_automatica boolean not null default false,
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table restaurantes.branch_voice_languages enable row level security;

create policy "owner/admin o sistema lee los idiomas de voz" on restaurantes.branch_voice_languages for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = branch_voice_languages.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin crea los idiomas de voz de su sucursal" on restaurantes.branch_voice_languages for insert
  with check (
    updated_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = branch_voice_languages.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and exists (
      select 1 from core.property p
      where p.id = branch_voice_languages.property_id and p.organization_id = branch_voice_languages.organization_id
    )
  );

create policy "owner/admin actualiza los idiomas de voz de su sucursal" on restaurantes.branch_voice_languages for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_voice_languages.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    updated_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = branch_voice_languages.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.branch_voice_languages from public, anon;
grant select on restaurantes.branch_voice_languages to authenticated;
grant insert (property_id, organization_id, idioma_principal, idiomas_adicionales, deteccion_automatica, updated_by, updated_at)
  on restaurantes.branch_voice_languages to authenticated;
grant update (idioma_principal, idiomas_adicionales, deteccion_automatica, updated_by, updated_at)
  on restaurantes.branch_voice_languages to authenticated;
grant select, insert, update, delete on restaurantes.branch_voice_languages to service_role;
