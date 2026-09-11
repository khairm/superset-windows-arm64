import os from "node:os";
import { getHostId, getHostName } from "@superset/shared/host-info";
import {
	getHostInstallSource,
	HOST_SERVICE_VERSION,
} from "../../../install-source";
import { protectedProcedure, router } from "../../index";

/**
 * (CLOUD-SEVERANCE-P2) The organization, locally.
 *
 * Upstream asked the cloud for the organization behind the JWT and threw
 * PRECONDITION_FAILED when it could not be resolved — one of the few cloud
 * reads in this service that was not already wrapped in a catch, so a severed
 * client would have turned `host.info` from "describes this machine" into a
 * hard error. The id is the only part anything downstream uses; the name and
 * slug are display text for a screen that no longer has a cloud organization
 * to describe.
 */
function getOrganization(organizationId: string): {
	id: string;
	name: string;
	slug: string;
} {
	return { id: organizationId, name: "Local", slug: "local" };
}

export const hostRouter = router({
	info: protectedProcedure.query(async ({ ctx }) => {
		const organization = getOrganization(ctx.organizationId);

		return {
			hostId: getHostId(),
			hostName: getHostName(),
			version: HOST_SERVICE_VERSION,
			installSource: getHostInstallSource(),
			organization,
			platform: os.platform(),
			arch: os.arch(),
			uptime: process.uptime(),
		};
	}),
});
