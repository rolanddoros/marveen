---
name: marveen-approvals
description: The autonomy levels of this Marveen install (1 notify only, 2 approval first, 3 act and report) and the approval API steps (request, status, consume). Use before any autonomous action in a category of store/autonomy-config.json, when an action needs owner approval, and when an approval comes back approved, rejected, timed out or with a 409 or 403.
---

Generated from templates/skills/marveen-approvals.md; local edits are overwritten.

# Autonomy and approval

The levels of autonomous actions are set in `{{projectRoot}}/store/autonomy-config.json` (level: 1 = notify only,
2 = propose and get approval, 3 = act on your own and report). Before you act on your own, look up the level of that
category.

The commands below use the API helper. Every dashboard call of yours goes through it, and the text always comes from
a file: write the file with your file tool (Write) first, then pass its path. The helper reads the token itself, so
it never lands on a command line. Without the helper (its deny rule is set for you), the same calls are in the
marveen-messaging skill, section "Without the helper".

Your payload files: `<your-dir>/api-uzenet.txt` (messages) and `<your-dir>/api-jovahagyas.txt` (approval requests),
where `<your-dir>` is `{{projectRoot}}/agents/<your-name>` for a sub-agent and `{{projectRoot}}` for the main agent.

One file, one send: write it, send it, and only then the next one. Do not prepare two in parallel (it is the same
file, the second would overwrite the first). The helper empties the file after a successful send and stops with an
error on an empty file, so it never sends an old text.

## Level 1 (notify only)

Send an inter-agent notice to the main agent ({{mainAgentId}}), but do NOT carry out the action. Then STOP.

Write the message text to `<your-dir>/api-uzenet.txt` (for example
`[FELHÍVÁS] CATEGORY_KEY: what I wanted to do, but level 1 lets me only notify.`), then send it:

```bash
{{apiHelper}} message <your-name> {{mainAgentId}} <your-dir>/api-uzenet.txt
```

## Level 2 (approval needed)

Ask for approval through the API BEFORE you act.

1. Request it: write the description (what you plan to do and why) to `<your-dir>/api-jovahagyas.txt`, then:

   ```bash
   {{apiHelper}} approval-request <your-name> CATEGORY_KEY 3600 <your-dir>/api-jovahagyas.txt
   ```

   The answer carries the id you check the decision with.
2. Check the decision, repeated every 60 seconds:

   ```bash
   {{apiHelper}} approval-status <id>
   ```

   - `status=rejected` or `status=timeout`: do not do it, log the reason.
   - `status=approved`: the approval can be used ONCE. BEFORE you act, consume it (APPROVALCONSUME1022):

     ```bash
     {{apiHelper}} approval-consume <id> CATEGORY_KEY <your-name>
     ```

3. Act only after exit code 0 (HTTP 200). A 409 (already_consumed, expired, not_approved, hash_mismatch) means do
   NOT do it: request a new approval.
4. With your own token (AGENT_TOKENS, see marveen-messaging): a 403 (agent-identity-binding) means the approval is
   NOT for you. With your own token you may consume only your own request, or one the main agent ({{mainAgentId}})
   filed for you with `for_agent`. Do NOT act. Ask {{mainAgentId}} (in an inter-agent message, with the description of
   the action and the content_hash) to file the approval for you with the field `"for_agent":"<your-name>"`; it
   cannot be added to an existing row afterwards. The owner approves the new row, and you consume that one by its id.
5. If the request had a content_hash (`--content-hash <h>`), give the same one when you consume it
   (`--content-hash <h>`).
6. Exception: for the email_send and data_delete categories do NOT call consume (409 wrong_category); the send path
   and the delete path consume those themselves.

## Level 3 (autonomous)

You carry out the action, then report it to the main agent.
