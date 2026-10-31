import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Set while an invitation is being accepted (`acceptInvite`): the Better Auth `afterAddMember` hook then must NOT create
 * a fresh club_members row for the new account membership, because the invited (account-less) row gets linked instead.
 */
export const inviteLinkContext = new AsyncLocalStorage<{ clubMemberId: string }>();
