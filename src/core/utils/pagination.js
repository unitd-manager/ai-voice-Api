import { z } from 'zod';
export const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(40).optional() });
// Takes rows fetched with take=limit+1 and returns {items, meta}.
export function paginate(rows, limit) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, meta: { limit, nextCursor: hasMore ? items[items.length - 1].id : null } };
}
