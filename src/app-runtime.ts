import { PolyglotExecutor } from "./executor.js";
import { JobManager } from "./jobs.js";
import { getProjectDir } from "./project-context.js";
import { detectRuntimes, getAvailableLanguages } from "./runtime.js";

export const runtimes = detectRuntimes();
export const available = getAvailableLanguages(runtimes);
export const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: () => getProjectDir(),
});
export const jobManager = new JobManager();
