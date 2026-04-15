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

export interface UpsertCronJobInput {
  name: string;
  agentId: string;
  schedule: { kind: "cron"; expr: string; tz: string };
  sessionTarget: "isolated" | "main" | "current" | `session:${string}`;
  payload: { kind: "agentTurn"; message: string };
  enabled?: boolean;
}

export async function upsertCronJob(input: UpsertCronJobInput): Promise<void> {
  const existing = await listCronJobs({ namePrefix: input.name });
  const match = existing.find((j) => j.name === input.name);

  const common = {
    name: input.name,
    agentId: input.agentId,
    schedule: input.schedule,
    sessionTarget: input.sessionTarget,
    payload: input.payload,
    enabled: input.enabled ?? true,
  };

  if (match) {
    await getOpenClawClient().request("cron.update", { id: match.id, ...common });
  } else {
    await getOpenClawClient().request("cron.add", common);
  }
}

export async function removeCronJobByName(name: string): Promise<void> {
  const existing = await listCronJobs({ namePrefix: name });
  const match = existing.find((j) => j.name === name);
  if (!match) return;
  await getOpenClawClient().request("cron.remove", { id: match.id });
}

export async function forceRunCronJob(jobId: string): Promise<string> {
  const res = await getOpenClawClient().request("cron.run", { id: jobId, mode: "force" });
  return (res as unknown as { result?: { runId?: string } }).result?.runId as string;
}
