# verify-restaurantes-voz-ambiente-tecleo

Verificación, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/087_ajustes_agente_ambiente_tecleo_humano.sql`
(espejo: `supabase/migrations/20240101000398_087_ajustes_agente_ambiente_tecleo_humano.sql`): cuatro columnas nuevas en
`restaurantes.agent_runtime_settings` (preset de ambiente, tecleo, volumen del tecleo y naturalidad del preset
`restaurante-humano`). Sin tablas nuevas.

## Qué demuestra (11 escenarios)

- **A.** Valores por omisión: el comportamiento anterior no cambia (sin tecleo, sin naturalidad).
- **B.** Escritura: owner de su organización sí; staff, otra organización (cross-tenant) y `anon` no.
- **C.** CHECK: preset fuera de la lista, volumen de tecleo > 25 y volumen de fondo > 20 mueren en la base.
- **D.** Lectura: la sesión de SISTEMA (servicio de llamadas) lee las columnas; `anon` no.
- **E.** Base sin migrar: 42703 se recupera con SAVEPOINT (lo que hace `runWithSavepointFallback`).

## Cómo correrlo

- Local: `bash ~/atiende-loop/heavy.sh scripts/verify-restaurantes-voz-ambiente-tecleo/run.sh` (Postgres efímero en el puerto 55787; no toca ninguna base real).
- CI: lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs`.
