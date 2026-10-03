/**
 * Promotions ("offers"): definitions of things Anthropic occasionally grants that change what optimal routing
 * looks like, such as a one-time free session reset per account. Definitions are data, not code: a bundled
 * offers.json ships with the package, a feed URL is checked daily so new promotions reach existing installs,
 * and a local list in config can add or override. An offer is active from startsAt until its deadline and
 * disappears from the UI when it expires or every account has used it.
 */
import { z } from "zod";

export const OfferSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  kind: z.literal("free-reset"),
  title: z.string(),
  description: z.string().optional(),
  url: z.string().optional(),
  startsAt: z.string().optional(),
  deadline: z.string(),
  usesPerAccount: z.number().int().min(1).default(1),
  resets: z.array(z.enum(["session", "weekly", "model"])).default(["session", "weekly", "model"]),
});
export type Offer = z.infer<typeof OfferSchema>;

export const OffersFeedSchema = z.object({ version: z.literal(1), offers: z.array(OfferSchema) });

export function parseFeed(raw: unknown): Offer[] {
  const r = OffersFeedSchema.safeParse(raw);
  if (!r.success) throw new Error(`offers feed is invalid: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data.offers;
}

/** Later sources win by id: bundled < feed < local. */
export function mergeOffers(...sources: Offer[][]): Offer[] {
  const m = new Map<string, Offer>();
  for (const list of sources) for (const o of list) m.set(o.id, o);
  return [...m.values()];
}

export function offerActive(o: Offer, now = Date.now()): boolean {
  const start = o.startsAt ? Date.parse(o.startsAt) : -Infinity;
  const end = Date.parse(o.deadline);
  return Number.isFinite(end) && now >= start && now <= end;
}

export function activeOffers(all: Offer[], disabled: string[], now = Date.now()): Offer[] {
  return all.filter((o) => !disabled.includes(o.id) && offerActive(o, now));
}
