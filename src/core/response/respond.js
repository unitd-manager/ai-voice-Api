export const ok = (res, data = {}, meta = {}, status = 200) =>
  res.status(status).json({ success: true, data, meta });
export const created = (res, data = {}, meta = {}) => ok(res, data, meta, 201);
export const fail = (res, status, code, message, details) =>
  res.status(status).json({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
    requestId: res.req?.id,
  });
