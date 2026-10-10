// Usage: validate({ body, query, params }) with Zod schemas. Parsed values replace the originals.
export const validate = (schemas) => Object.assign((req, _res, next) => {
  try {
    for (const key of ['params', 'query', 'body']) {
      if (!schemas[key]) continue;
      const parsed = schemas[key].parse(req[key]);
      if (key === 'query') Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      else req[key] = parsed;
    }
    next();
  } catch (e) { next(e); }
}, { schemas }); // schemas are exposed so docs can be generated from the real validators
