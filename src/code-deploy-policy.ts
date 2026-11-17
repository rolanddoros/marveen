// The code deploy's server-side policy (plan-v3 3 and 5, Ron 17165), read by src/web/routes/approvals.ts.
//
// SEC-5: with CODE_DEPLOY_OWNER_CHANNEL_ONLY on, a code_deploy approval is approved only through a channel whose
// resolved_by the server writes itself: the owner's own dashboard session (owner_session:<user>) or the Slack
// reaction route (slack_reaction:<id>); a body may then carry neither prefix for any category. The default is
// Roland's decision (plan-v3 11); until he decides, the fail-closed side. scripts/deploy/fork-deploy.mjs carries the
// same value, pinned equal by src/__tests__/approvals-code-deploy.test.ts: the helper's check and the server's must
// not drift apart.
export const CODE_DEPLOY_OWNER_CHANNEL_ONLY: boolean = true

export const CODE_DEPLOY_CATEGORY = 'code_deploy'

/** The resolved_by prefixes only the server writes (the owner session here, the Slack route in approval-slack-route.ts). */
export const SERVER_WRITTEN_RESOLVED_BY_RX = /^\s*(?:owner_session|slack_reaction):/i
