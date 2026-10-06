import { useLingui } from "@lingui/react/macro";
import { errorMessage } from "@superset/i18n/errors";
import { toast } from "@superset/ui/sonner";
import { workspaceTrpc } from "@superset/workspace-client";
import { useCallback, useState } from "react";
import type { ChangesetFile } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useChangeset";
import { FileDiscardDialog } from "./components/FileDiscardDialog";

export function useFileDiscard(workspaceId: string) {
	const { t } = useLingui();
	const utils = workspaceTrpc.useUtils();
	const { mutate: discard } = workspaceTrpc.git.discardChanges.useMutation({
		onSuccess: () => {
			void utils.git.getStatus.invalidate({ workspaceId });
			void utils.git.getDiff.invalidate({ workspaceId });
		},
		onError: (err) => {
			toast.error(t({ message: "Couldn't discard changes" }), {
				description: errorMessage(err),
			});
		},
	});
	// The last target stays mounted so the dialog animates closed.
	const [target, setTarget] = useState<ChangesetFile | null>(null);
	const [open, setOpen] = useState(false);
	const requestDiscard = useCallback((file: ChangesetFile) => {
		setTarget(file);
		setOpen(true);
	}, []);

	const discardDialog = target && (
		<FileDiscardDialog
			file={target}
			open={open}
			onOpenChange={setOpen}
			onConfirm={() => {
				setOpen(false);
				discard({ workspaceId, filePath: target.path });
			}}
		/>
	);

	return { requestDiscard, discardDialog };
}
