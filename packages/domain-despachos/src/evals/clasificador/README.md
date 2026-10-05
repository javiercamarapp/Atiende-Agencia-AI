# Conjunto dorado del clasificador contable (despachos)

`casos.json`: 100+ descripciones SINTÉTICAS (ningún dato de clientes) con la categoría esperada y, en algunos, la ClaveProdServ.
`ejecutor.ts` corre cada una por `clasificarCfdi` + `evaluarCompuertaClasificacion` (sin LLM, sin red) y mide:

- acierto de categoría (los casos con categoría única esperada);
- casos que DEBEN ir a revisión (empates, desacuerdo ClaveProdServ/descripción, sin coincidencias) y de hecho van;
- empates enviados a revisión (invariante: 100 %);
- errores silenciosos: categoría equivocada que la compuerta dejó pasar sin revisión.

`tests/clasificador-evals.spec.ts` lo corre en CI y escribe el porcentaje en el log (y en el resumen del job si existe
`GITHUB_STEP_SUMMARY`). **No bloquea**: el umbral lo fija Javier; mientras tanto `EVAL_CLASIFICADOR_UMBRAL=<0-100>` permite ensayarlo.
