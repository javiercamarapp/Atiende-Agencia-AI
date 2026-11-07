# verify-restaurantes-reactivacion

Prueba contra Postgres REAL (RLS, GRANT y `auth.uid()` reales) la migracion `packages/domain-restaurantes/migrations/150_reactivacion_automatica.sql`
(reactivacion automatica de clientes dormidos 14-21 dias y captura conversacional de opt-in). Datos 100 % sinteticos.

Escenarios (ver `assertions.sql`; cada uno termina en UN solo `count(*)` entero o en un SQLSTATE exacto):

- **A. Universo opt-in**: sin consentimiento `otorgado` el universo es 0; revocado (BAJA) sale; fuera de la ventana no entra; modo apagado o sin configuracion = 0.
- **B. Candidatos**: favorito del historial, interruptor por sucursal (apagado por omision), queja reciente, topes de frecuencia.
- **C. Registro y configuracion**: idempotencia por persona y dia, `real` exige simulacion previa, rangos, cross-tenant, admin acotado, anon, solo-sistema.
- **D. Opt-in conversacional**: una sola pregunta, SI otorga (fuente `agente_whatsapp`), NO no se repite, revocado/queja/bandera apagada nunca preguntan.
- **E/F. RLS y metricas**: lectura solo owner/admin, sin escritura directa, recompra/control/bajas/respuesta.

Uso manual: `scripts/verify-restaurantes-reactivacion/run.sh` (Postgres local con `initdb`). En CI lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`.
NOTA: este script se escribio sin Postgres disponible en la Mac de desarrollo; falta su primera corrida real (ver el reporte de la ronda R23).
