import { useLingui } from "@lingui/react/macro";
import { getBaseName } from "renderer/lib/pathBasename";
import { DiscardConfirmDialog } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/DiscardConfirmDialog";
import type { ChangesetFile } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useChangeset";

interface FileDiscardDialogProps {
	file: ChangesetFile;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}

export function FileDiscardDialog({
	file,
	open,
	onOpenChange,
	onConfirm,
}: FileDiscardDialogProps) {
	const { t } = useLingui();
	const basename = getBaseName(file.path);
	const isDeleteAction = file.status === "untracked" || file.status === "added";
	return (
		<DiscardConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title={
				isDeleteAction
					? t({
							message: `Delete "${basename}"?`,
						})
					: t({
							message: `Discard changes to "${basename}"?`,
						})
			}
			description={
				isDeleteAction
					? t({
							message:
								"This will permanently delete this file. This action cannot be undone.",
						})
					: t({
							message:
								"This will revert all changes to this file. This action cannot be undone.",
						})
			}
			confirmLabel={
				isDeleteAction
					? t({
							message: "Delete",
						})
					: t({
							message: "Discard",
						})
			}
			onConfirm={onConfirm}
		/>
	);
}
