# Arnes de evaluacion del agente de Los Taquitos de PM

68 casos dorados (`casos.json`: 47 llamadas y 21 chats) del experto, corridos SIN LLM real:

- `mundo.ts`: herramientas del registro unico (`agent-tools/registry.ts`, mismos nombres) sobre fixtures (menu provisional
  `menu-pm.json`, zonas inventadas solo para el arnes, clientes conocidos, fallas inyectadas). Replica minimo de $200,
  alcohol a domicilio, zona, regional, ordenes de N, tortilla y la maquina cotizado -> confirmado -> creado.
- `referencia.ts`: agente de referencia guionado (trayectoria dorada por caso).
- `graders.ts`: 19 graders deterministas (comanda, repeticion antes de crear, escalacion, reglas R1-R12, tono de usted, seguridad).
- `ejecutor.ts`: corre un caso o la suite y resume umbrales.
- Prueba: `packages/domain-restaurantes/tests/evals-agente-pm.spec.ts` (corre en CI con `npm run test:unit`).

## Contrato objetivo vs actual
El set pide dos cosas que el servidor aun no tiene: tortilla `mixta` (PR-3) y promociones automaticas por dia/canal (PR-4).
`CONTRATO_OBJETIVO` las simula; `CONTRATO_ACTUAL` se comporta como el registro de hoy. La prueba fija que en el contrato
actual solo fallan C06, C14, L02, L07 y L30.

## Modo LLM real (manual, NO corre en CI)
`PM_EVALS_REAL=1 ANTHROPIC_API_KEY=... PM_EVALS_MODEL=<modelo> [PM_EVALS_MAX_USD=2] [PM_EVALS_K=1] [PM_EVALS_CASOS=L01,C05] npm run evals:pm:real -w @atiende/domain-restaurantes`

Un LLM hace de agente (prompt de PM + herramientas del registro) y otro de cliente. Se corta al llegar al tope de gasto y
lista los casos sin correr. La frase `debe_decir_algo_equivalente_a` no se evalua de forma determinista (requiere juez LLM, pendiente).
