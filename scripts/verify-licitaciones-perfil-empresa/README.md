# verify-licitaciones-perfil-empresa

Verificacion contra Postgres REAL (RLS, triggers, GRANT por columna, funciones `security definer` y `auth.uid()` reales) de
`packages/domain-licitaciones/migrations/040_licitaciones_perfil_empresa_completo.sql` (L-P3-03/04: perfil de empresa completo,
firmantes con vigencia del poder y procedencia por campo, REQ-141/142/145).

`assertions.sql` (28 escenarios, una conexion cada uno) cubre:

- **Migracion**: el unico viejo `(organization_id, role)` de `company_signer` ya no existe y caben dos firmantes del mismo cargo; el
  firmante anterior (sin vigencia) sigue legible.
- **Tablas nuevas** (perfil, productos y servicios, ubicaciones, restricciones, socios y representantes): nacen pendientes con
  `proposed_by` fijado por el trigger; no se puede insertar ya aprobado ni fijar `approval_status`/`proposed_by`/`approved_by` (42501 por
  columna); RFC, ventas, trabajadores, sector, porcentaje (0-100, dos decimales, solo socios) y fechas se validan con CHECK; un perfil por
  organizacion; DB-03 (editar un dato aprobado lo regresa a pendiente en la misma sentencia; un UPDATE sin cambio no).
- **Firmantes**: vigencia invertida rechazada; el documento de identidad o poder debe ser de la misma organizacion.
- **Aprobacion** (`decide_company_item` extendida): analyst/owner/admin aprueban y rechazan los tipos nuevos, el autor no decide su dato,
  writer y viewer no (42501), tipo invalido 22023, segunda decision = `conflict`, bitacora con el tipo nuevo; la tarifa sigue siendo solo
  owner/admin (regresion).
- **Procedencia (REQ-142)**: `authenticated` no escribe `field_provenance` por SQL (42501 insert/update/delete); `record_field_provenance`
  exige sesion = llamador, rol de escritura, registro propio y entidad/fuente validas; repetirla actualiza sin duplicar; **si la
  procedencia falla, el dato recien insertado se revierte** (misma transaccion); un dato sembrado por SQL no tiene procedencia.
- **Cross-tenant, anon y sin sesion** en tablas y funciones; bajas (el writer borra productos y ubicaciones, NO restricciones ni socios);
  `service_role` conserva el acceso de mantenimiento.
- **Mapeos de requisitos**: el CHECK de `requirement_fulfillment_mapping.kind` admite perfil, socios, restricciones, ubicaciones y productos (owner) y rechaza
  cualquier otro tipo (23514); el writer no mapea (42501).
- **Aviso de poder por vencer**: `system_count_signer_powers_expiring` solo corre en sesion de sistema y cuenta unicamente firmantes aprobados,
  autorizados y con vigencia dentro de la ventana.

- Gate de CI (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-perfil-empresa/run.sh`.
