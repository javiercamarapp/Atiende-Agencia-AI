# verify-hoteles-privacidad-publica

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-privacidad-arco/`) de
`packages/domain-hoteles/migrations/042_hoteles_privacidad_publica_huesped.sql` (H-30: aviso público,
solicitud ARCO pública con verificación por código, exportación de datos del huésped y "mis datos").

```
scripts/verify-hoteles-privacidad-publica/run.sh        # manual, Postgres efímero local
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-privacidad-publica
```

En CI lo ejecuta el gate `Postgres real` (auto-descubre `scripts/verify-*`). Verificación técnica de una
implementación; NO es asesoría legal.

## Qué prueba (22 escenarios numerados en assertions.sql)

- Funciones públicas solo-sistema (`auth.uid()` nulo): un usuario autenticado de otro tenant y `anon` no las alcanzan (42501).
- Aviso vigente por slug: solo properties activas de hoteles; A1 con aviso, A2 sin aviso (no se inventa); slug de restaurantes o inexistente = 0 filas.
- Alta pública: queda `pendiente_verificacion`/`publico`, solo el hash del código, correo encolado, bitácora sin PII y sin actor; validaciones 22023; tope por contacto (la 4a devuelve NULL); limpieza de las no verificadas con 8 días.
- Verificación: correcto = `recibida` con plazo de 20 días desde hoy; un solo uso; 5 intentos y queda agotado aun con el código correcto; expirado; referencia inexistente.
- Una solicitud sin verificar no se puede avanzar por el staff (P0001).
- Las tablas nuevas no tienen GRANT para clientes; `anon` sin acceso a nada.
- Exportación: owner/gm; sin documento de identidad (ni sobre cifrado ni últimos dígitos); una huella por exportación; frontdesk, otro tenant y `anon` rechazados; huésped de otra property = 23503.
- "Mis datos": el enlace solo se emite para un ACCESO procedente por owner/gm; el snapshot del titular no incluye notas internas ni conversaciones y se revalida contra la base (deja de responder si la solicitud cambia).
- Base sin migrar: función ausente (42883) se recupera con SAVEPOINT (nunca 25P02).
- Los CHECKs ampliados de 032 siguen cerrados a otros valores; aislamiento cross-tenant de lectura directa.
