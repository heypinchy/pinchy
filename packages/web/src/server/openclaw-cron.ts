import { getOpenClawClient } from "@/server/openclaw-client";

export interface CronJob {
  id: string;
  name: string;
  schedule?: { kind: string; expr?: string; tz?: string };
  agentId?: string;
  enabled?: boolean;
}

export async function listCronJobs(opts?: { namePrefix?: string }): Promise<CronJob[]> {
  const res = await getOpenClawClient().request("cron.list", {});
  const jobs = ((res as unknown as { result?: { jobs?: CronJob[] } }).result?.jobs ??
    []) as CronJob[];
  if (opts?.namePrefix) {
    return jobs.filter((j) => j.name.startsWith(opts.namePrefix!));
  }
  return jobs;
}
