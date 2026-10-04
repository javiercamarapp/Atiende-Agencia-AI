# verify-restaurantes-repartidor-perfil

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/044_repartidor_perfil_operativo.sql`
(espejo: `supabase/migrations/20240101000310_044_repartidor_perfil_operativo.sql`): perfil operativo del repartidor
(`restaurantes.repartidor_perfil` y `repartidor_perfil_privado`, `guardar_perfil_repartidor`, `suprimir_perfil_repartidor`,
`licencias_por_vencer_sistema`) y el tipo de bitacora `exportacion`.

Cubre: el repartidor guarda y lee SOLO su perfil; owner/admin guardan y leen los de su organizacion; el staff de piso lee lo
operativo pero NO licencia ni contacto de emergencia; otro repartidor, otro tenant y anon no leen; escritura directa en las tablas
rechazada (42501); validaciones (enum, telefono de 10 digitos, pares licencia/emergencia, vigencia, longitudes; 22023); owner sobre quien
no es repartidor (P0002); supresion ARCO solo owner/admin; baja del repartidor borra ambos perfiles (FK en cascada); barrido de
licencias por vencer solo de sistema y sin PII; tipo de bitacora admitido/rechazado; base sin migrar (42883 recuperable con subtransaccion).

- Manual: `scripts/verify-restaurantes-repartidor-perfil/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
