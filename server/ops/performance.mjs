/**
 * One pollable snapshot for the Performance page: how hard the machine is working, plus which apps
 * are doing the working. The host figures come from the kernel (cheap, unprivileged); the per-app
 * figures come from `docker stats` and each container's live state, so the page can sort by load
 * and offer start/pause/stop right where the usage is shown.
 */
import { defineOperation } from "./registry.mjs";
import { parseDockerStats, aggregateAppStats } from "./apps.mjs";

export function performanceOperations() {
  return [
    defineOperation({
      id: "system.performance.inspect", title: "Read live system performance", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "CPU, memory, swap, temperatures and disk use for this server, with the live CPU and memory of each installed app.",
      run: async (_parameters, { run, apps, performance }) => {
        const docker = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";
        const [host, { applications }, stats] = await Promise.all([
          performance.snapshot(),
          apps.inspect({}),
          run(docker, ["stats", "--no-stream", "--format", "json"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" })),
        ]);
        const perApp = stats.ok ? aggregateAppStats(parseDockerStats(stats.stdout), applications.map((application) => application.id)) : {};
        const runningApps = applications.filter((application) => application.installed).map((application) => ({
          id: application.id,
          state: application.container?.status ?? (application.container?.running ? "running" : "absent"),
          running: Boolean(application.container?.running),
          cpuPercent: perApp[application.id]?.cpuPercent ?? 0,
          memBytes: perApp[application.id]?.memBytes ?? 0,
          containers: perApp[application.id]?.containers ?? 0,
        }));
        return { ...host, statsAvailable: stats.ok, apps: runningApps };
      },
    }),
  ];
}
