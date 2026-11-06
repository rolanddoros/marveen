### API helper (every dashboard call)
`bash {{projectRoot}}/scripts/marveen-api.sh <verb> ...`, syntax: `--help`. It reads the token itself: the token never goes on a command line. Text never comes from an argument: write it to a file and pass the path{{stdinClause}}.{{strictNote}}
- messages: message, message-close (--report: nobody waits for an answer), directive-verify
- memory: memory-search (its X-Memory-Search line: relaxed=true is not evidence), memory-save, memory-list, memory-move, memory-update, daily-log, taskstate-save
- approvals: approval-request, approval-wait (exit 3: no decision yet: call again; exit 4: approved but already consumed or the window expired: request a new one), approval-status, approval-consume
- kanban: kanban-list, kanban-card{{kanbanWriteVerbs}}
- other: skill-propose, schedules-list, agents-list
Exit: 0 ok; 1 server error; 2 usage or no token, nothing sent; 3 unreachable: read back before retrying a write; 4 already closed or consumed: not an error, do not retry; 5 or 6 message text refused or checker failed, nothing sent; 7 accepted but not applied: read back; 8 not approved: do not act.
