# verify-restaurantes-privacidad-arco

Verificacion contra Postgres REAL (RLS, GRANT por columna y `auth.uid()` reales) de
`packages/domain-restaurantes/migrations/030_privacidad_arco_aviso_retencion.sql`
(PM PR-9: ARCO, aviso de privacidad, consentimiento de grabacion y retencion). El
repositorio en memoria no aplica RLS ni GRANT, asi que solo esta prueba puede detectar
un hueco de autorizacion.

Cubre: solicitudes ARCO (registro de sistema idempotente, canal de voz con identidad por
identificador de llamada, confirmacion/retiro con plazos 20 + 15 dias, expiracion a 24 h,
actualizacion de estado solo owner/admin, lectura por RLS, escritura directa denegada,
bitacora append-only); `privacy_config` (solo owner/admin escribe via funcion, lectura
acotada, CHECK de retencion y URL https); evidencia del aviso (primera entrega atomica,
version nueva, solo sistema); consentimiento de grabacion (negar borra lo ya guardado,
`voz_registrar_turno` no persiste sin consentimiento ni con retencion 0, cross-tenant);
purga por retencion (por organizacion, respeta solicitudes ARCO abiertas, solo sistema); y
el SQLSTATE real (42883) de una base sin migrar recuperado con SAVEPOINT.

Los escenarios negativos usan `verify_support.expect_sqlstate` (SQLSTATE exacto).
Uso manual: `scripts/verify-restaurantes-privacidad-arco/run.sh`. En CI lo descubre
`scripts/verify-real-postgres-ci/run-gate.mjs` (bootstrap.sql + post-migrations.sql +
assertions.sql). No es asesoria legal.
