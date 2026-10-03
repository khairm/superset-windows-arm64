// (HOST-LAUNCH-IGNORED-TASK)
import { listGitIgnoredDirsOrThrow } from "../../runtime/git/ignored-dirs.ts";
import { defineWorkerTask } from "../define-worker-task.ts";

export const gitIgnoredDirsTask = defineWorkerTask<
	{ rootPath: string },
	string[]
>({
	type: "git/listIgnoredDirs",
	handler: ({ rootPath }) => listGitIgnoredDirsOrThrow(rootPath),
});

export const gitReadTasks = [gitIgnoredDirsTask];
