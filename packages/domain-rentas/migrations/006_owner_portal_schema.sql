-- Fase 3 — Portal de propietario (solo lectura). Ver diseño Fase 3 rentas §1-§2 para
-- la justificación completa de la decisión de identidad: el propietario NO es staff
-- (nunca encaja en `core.membership`, que es siempre 1 organización — modelo N:M real
-- owner<->empresa_gestora ya en producción desde Fase 1, `rentas.owner_organization`).
-- Su identidad es `rentas.owner.id` mismo (ya existe desde 001), la sesión de BD se
-- abre vía `TenancyEngine.withAppSession({userId: ownerId})` -- genérico, no requiere
-- ningún cambio en core.*/core-auth/core-tenancy/core-authz (verificado línea por
-- línea, ver diseño §7).
--
-- Requiere: 001/005 ya aplicadas (rentas.owner, rentas.unidad, rentas.owner_organization,
-- rentas.owner_statement, rentas.owner_statement_linea).

-- ---------------------------------------------------------------------------
-- Credencial de acceso al portal de propietario. Deliberadamente NO se añaden
-- password_hash/email_verified_at directo a rentas.owner: esa tabla ya es visible en
-- SELECT para cualquier staff de cualquier organización vinculada vía
-- owner_organization (policy "staff ve owners de su organización", 001), y mezclar
-- material de autenticación en una fila multi-tenant-visible es la clase de bug que
-- una tabla separada con RLS propia evita por construcción, no por disciplina.
-- ---------------------------------------------------------------------------
create table rentas.owner_credential (
  owner_id uuid primary key references rentas.owner(id) on delete cascade,
  password_hash text,
  email_verified_at timestamptz,
  -- 'invite' = provisto por staff (único origen en esta fase, ver diseño §5); nunca
  -- 'registro_autoservicio' -- un propietario no se auto-registra, alguien con
  -- membership real de una organización vinculada certifica que es él.
  created_via text not null default 'invite' check (created_via in ('invite')),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Token de invitación/reset de un solo uso -- se limpia (null) al consumirse, nunca
  -- se reutiliza (ver ejecutor de dominio `consumePortalInvite`).
  password_reset_token_hash text,
  password_reset_expires_at timestamptz
);

alter table rentas.owner_credential enable row level security;
-- Ninguna policy de SELECT para 'authenticated' -- ni el propio propietario necesita
-- leer su password_hash. Solo service_role la toca (login/reset se validan
-- server-side con una sesión de privilegio administrativo, igual criterio que
-- `core.staff_user` hoy vía `verifyPassword` -- ver diseño §3/§7).
revoke all on rentas.owner_credential from public, anon, authenticated;
grant select, insert, update on rentas.owner_credential to service_role;

-- ---------------------------------------------------------------------------
-- Políticas NUEVAS, ADITIVAS -- las policies de staff de 001/005 no se tocan (Postgres
-- evalúa políticas del mismo comando con OR: una sesión de staff sigue funcionando
-- exactamente igual, y una sesión de propietario nunca "cuela" en una policy de staff
-- porque `core.membership` nunca tiene fila para un ownerId).
-- ---------------------------------------------------------------------------
create policy "propietario ve su propio registro" on rentas.owner for select
  using (id = auth.uid());

create policy "propietario ve sus propias unidades" on rentas.unidad for select
  using (owner_id = auth.uid());

create policy "propietario ve sus propios statements" on rentas.owner_statement for select
  using (owner_id = auth.uid());

create policy "propietario ve líneas de sus propios statements" on rentas.owner_statement_linea for select
  using (exists (
    select 1 from rentas.owner_statement os
    where os.id = owner_statement_linea.statement_id and os.owner_id = auth.uid()
  ));

-- Bono de UX gratis: el propietario también puede ver en qué organizaciones tiene
-- presencia, para GET /rentas/owner-portal/me -- misma tabla ya existente (001), misma
-- técnica.
create policy "propietario ve sus propios vínculos owner_organization" on rentas.owner_organization for select
  using (owner_id = auth.uid());

-- Nota de diseño: `grant select ... to authenticated` ya existe desde 001/005 sobre
-- rentas.owner/rentas.unidad/rentas.owner_statement/rentas.owner_statement_linea/
-- rentas.owner_organization -- el rol de conexión Postgres (`authenticated`) es el
-- mismo para staff y para propietario (la separación real la hace la RLS, no el rol).
-- No hace falta ningún `grant` nuevo sobre esas tablas, solo las `create policy` de
-- arriba.
