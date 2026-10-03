import type { AccountState, Usage } from "../src/core/types.js";
import { emptyState } from "../src/core/accounts.js";

export function usage(
  fiveHour: number | null,
  sevenDay: number | null,
  models: Record<string, number> = {},
  resetsIn = 3600_000,
  weeklyResetsIn = 7 * 86400_000,
): Usage {
  const resetsAt = new Date(Date.now() + resetsIn).toISOString();
  return {
    fiveHour: { utilization: fiveHour, resetsAt },
    sevenDay: { utilization: sevenDay, resetsAt: new Date(Date.now() + weeklyResetsIn).toISOString() },
    models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { utilization: v, resetsAt: new Date(Date.now() + weeklyResetsIn).toISOString() }])),
    extra: {},
    fetchedAt: Date.now(),
    source: "poll",
  };
}

export function account(
  name: string,
  fiveHour: number | null,
  sevenDay = 10,
  models: Record<string, number> = {},
  extra: Partial<AccountState> = {},
): AccountState {
  return { ...emptyState({ name, configDir: `/tmp/${name}` }), usage: usage(fiveHour, sevenDay, models), ...extra };
}

export function accountResetting(
  name: string,
  fiveHour: number,
  sevenDay: number,
  weeklyResetsInHours: number,
  models: Record<string, number> = {},
): AccountState {
  return { ...emptyState({ name, configDir: `/tmp/${name}` }), usage: usage(fiveHour, sevenDay, models, 3600_000, weeklyResetsInHours * 3600_000) };
}
