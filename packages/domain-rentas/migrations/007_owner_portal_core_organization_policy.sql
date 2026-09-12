-- Fase 3 — Portal de propietario, fix post-verificación. La migración 006 agregó
-- policies aditivas sobre rentas.owner/unidad/owner_statement/owner_statement_linea/
-- owner_organization, pero las queries del portal (listUnidadesPropietario,
-- listOwnerStatementsPropietario, findOwnerStatementDetallePropietario,
-- listOwnerOrganizaciones) hacen JOIN contra core.organization para traer el nombre
-- de la organización gestora. core.organization tiene RLS con una sola policy
-- ("staff ve su propia organización", 0001), resuelta vía core.membership -- el
-- propietario nunca tiene fila ahí, así que ese JOIN descartaba silenciosamente
-- TODAS las filas, incluidas las propias del propietario legítimo. El modelo de
-- aislamiento owner_id = auth.uid() en sí era correcto; el portal completo devolvía
-- vacío para cualquier propietario contra Postgres real. Verificado con Postgres real
-- (no el repositorio en memoria, que no modela RLS de core.organization en absoluto).
--
-- Requiere: 0001 (core.organization, core.membership), 001/005/006 de rentas ya
-- aplicadas (rentas.owner_organization).

create policy "propietario ve organizaciones donde tiene presencia"
  on core.organization for select
  using (
    exists (
      select 1 from rentas.owner_organization oo
      where oo.organization_id = core.organization.id and oo.owner_id = auth.uid()
    )
  );
