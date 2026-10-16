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
`PM_EVALS_REAL=1 OPENROUTER_API_KEY=... PM_EVALS_MODEL=<id de OpenRouter, p.ej. openai/gpt-6-luna> [PM_EVALS_MAX_USD=2] [PM_EVALS_K=1] [PM_EVALS_CASOS=L01,C05] [PM_EVALS_TEMPERATURE=0] [PM_EVALS_REASONING=low] npm run evals:pm:real -w @atiende/domain-restaurantes` (corre con `vite-node`: `node --experimental-strip-types` no resuelve los imports `.js` -> `.ts` de agent-core en Node 26)

Pasa por el `OpenRouterProvider` del gateway (el mismo que produccion; ver `docs/LLM-GATEWAY.md`): tool calling real y costo real de OpenRouter. Con una sola llave se barre cualquier modelo. Por omision NO se manda `temperature` (GPT-6, Claude 5.x y Gemini Flash-Lite la rechazan o no la soportan). La llave se lee del entorno (p.ej. `OPENROUTER_API_KEY=$(cat ~/.atiende-secrets/OPENROUTER_API_KEY.txt)` en un subshell): nunca la imprimas ni la commitees.

Un LLM hace de agente (prompt de PM + herramientas del registro) y otro de cliente. Se corta al llegar al tope de gasto y
lista los casos sin correr. La frase `debe_decir_algo_equivalente_a` no se evalua de forma determinista (requiere juez LLM, pendiente).

## Escenarios de chats reales de T7 (PM-C5)
`escenarios-t7.json` (+ `escenarios-t7.ts`): 71 escenarios sacados de una muestra ANONIMIZADA de 104 chats reales de WhatsApp de T7
Garcia Lavin (8 semanas, 2-oct-2026). A diferencia de los casos dorados de `casos.json`, cada escenario trae lo que el cliente escribe
(`turnos_cliente`), lo que el agente debe hacer (`comportamiento_esperado`) y lo que NO debe hacer (`que_no_debe_hacer`) en texto libre
para un juez (LLM o persona): no se evaluan con graders deterministas ni corren en el modo LLM real todavia.
- `estado: "pendiente_decision"` = depende de una decision de Javier aun abierta (`dudas`, ver `DECISIONES_PENDIENTES`): se listan pero
  NO fallan el CI. Hoy son 8 (P1/P18 pedidos programados antes de abrir, P3/P7 cobertura cuando la sucursal dueña de la zona esta cerrada,
  P22 menu por link, P25 celulares personales).
- Datos personales: ninguno. Telefonos, nombres, enlaces y direcciones van como marcadores (`[NOMBRE]`, `[TEL]`, `[LINK DE MAPS]`...) y la
  prueba `tests/pm-c5-escenarios-t7.spec.ts` lo vigila con patrones. Nunca copies aqui texto de la muestra cruda.
- La prueba tambien ata las cifras que citan los escenarios (fracciones de kilo, extras a $19, totales) al motor real de pedidos sobre el
  catalogo sembrado de T7.

## Escenarios K y KH (lo que enseñan los chats reales de T7 y los huecos finales)
`escenarios-k.json` (+ `escenarios-k.ts`): 22 escenarios K y 10 KH, todos SINTETICOS (ningun texto, nombre ni telefono sale de los chats privados;
`tests/evals-agente-pm-k.spec.ts` lo vigila con patrones). Mismos campos de texto libre que `escenarios-t7.json`, mas:
- `verificacion: determinista`: el escenario esta atado en esa prueba a una comprobacion REAL contra el servidor (registro de herramientas, motor de pedidos,
  busqueda, entrada de Meta, prompt). Hoy son 20 (K01-K20).
- `verificacion: juez`: texto libre para un LLM o una persona (KH09 activo; los demas jueces estan pendientes de construccion).
- `estado: pendiente_construccion` + `depende_de`: depende de algo que main aun no tiene (cobertura por turnos en
  servidor, descripciones del menu en el seed, venta sugerida con interruptor, rastreo, subtipos de queja, cliente-360, botones de Meta). Se listan
  como `it.todo` citando de que dependen; no fallan el CI ni se fingen como aprobados.
- Falta (hueco conocido): un corredor que pase los 71 escenarios T7 y los K por el agente con un LLM guionado en CI, y un grader de juez; los T7 siguen
  validando solo su estructura.

## Escenarios de la ronda 3 (R3)
`escenarios-r3.json` (+ `escenarios-r3.ts`): 32 escenarios sinteticos de lo que rompio la medida de la ronda 3 contra la cuenta real (WhatsApp, voz con Gemini Live y motor de reglas;
defectos `QA-PM-R3-whatsapp|voz|reglas-NN`). Misma forma que los de la ronda 2; `tests/pm-r3-escenarios.spec.ts` vigila estructura, ausencia de datos personales y que cada
`cubierto_por` apunte a un spec que existe. Los que dependen de un dato de la base real o de una decision (`estado: pendiente_decision`, con `dudas`) se listan sin fallar el CI.
Los guiones de voz nuevos de esta ronda (V27 a V30) viven en `src/voz/simulador/guiones-es-mx.ts` y corren en `tests/voz-simulador-prueba-ciega.spec.ts`.
