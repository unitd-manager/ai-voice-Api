import { z } from 'zod';
export const analysisSchema = z.object({
  summary: z.string().max(2000),
  outcome: z.enum(['resolved', 'unresolved', 'follow_up_needed', 'transferred', 'voicemail', 'no_conversation']),
  customerIntent: z.string().max(300),
  actionItems: z.array(z.string().max(300)).max(10).default([]),
  leadQualification: z.enum(['hot', 'warm', 'cold', 'not_applicable']).default('not_applicable'),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  qualityScore: z.number().int().min(1).max(10),
  extracted: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
