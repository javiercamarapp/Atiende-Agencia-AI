# Banco de pruebas de voz (proveedor-agnóstico)

Esqueleto de la fase T01-T04 del diseño del banco. **No llama a ningún proveedor, no lee llaves y no gasta saldo.**

- Base (T01): rama `feat/voz-medicion-real-limpio` (PR #696), commit `af90fa87c`. Trae `scripts/voz-medicion-real/guardas.ts` y sus specs; el banco las reutiliza (loopback, BD local, Meta simulado, `parseCorte`/`excedeTope`/`sumarCosto` con NaN = corte).
- `tipos.ts`, `registro.ts`, `correr-llamada.ts` (T02): contrato `AdaptadorBanco` sobre el puerto `AbrirSesionLlamada` de voice-core (que NO se modifica), registro por id y corredor M0. Único adaptador: `adaptadores/falso.ts` (doble determinista).
- `compuerta-pedidos.ts`, `traza-herramientas.ts` (T03): la compuerta `confirmacionAntesDeCrear` como decorador de `ejecutarTool` con modos `on | off | servidor`. Reutiliza la función de producción `ejecutarHerramientas` (no hay copia de la regla); producción queda intacta. La traza cuenta los intentos de crear sin confirmar y los que llegaron a ejecutarse.
- `cliente-simulado.ts`, `corpus.ts` (T04): cliente M0 en modo `texto` o `stt-final` (ruido de `ruido-stt.ts`, pareado por semilla) y esquema/validador de escenarios. El corpus sintético privado se lee de la variable `PM_CORPUS_SIM` (ruta absoluta FUERA del repo) y nunca se copia aquí; `ejemplos/` trae 3 escenarios inventados.
- `topes.ts`, `aislamiento.ts`: topes por llamada y por corrida (máximo por omisión 25 USD) y aislamiento reutilizando #696.

CLI: `npx vite-node scripts/voz-banco/banco.ts listar | validar-corpus | ejemplo [on|off|servidor]`.
Pruebas: `packages/domain-restaurantes/tests/voz-banco-*.spec.ts`.
