/** One usage snapshot row as stored by the poller (see Db.usageHistory). */
export interface SnapshotRow {
  at: number;
  account: string;
  fiveHourUtil: number | null;
  sevenDayUtil: number | null;
  models: Record<string, { utilization: number | null; resetsAt?: string | null }>;
}
