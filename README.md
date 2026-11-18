# Dev dashboard

A local dashboard for a developer on a team that uses Azure DevOps. On one page it shows the team backlog from Azure Boards (with a burndown, a forecast and a dependency graph), your open pull requests and the ones waiting on your review, the worktrees of your main repo, Docker, your local sites and this machine.

It is a Node server with no dependencies and one HTML page. The server gets its data from `az`, `git`, `docker` and PowerShell and serves it as JSON endpoints to the page.

```
node server.js        # http://localhost:8138, bound to 127.0.0.1 only
```

There is no `npm install`. You need Node 18 or later and an active `az login` for the backlog and PRs; it uses `az account get-access-token`, so no token is stored anywhere. Docker Desktop is only needed for the Docker panel. It was built on Windows: the "This machine" and "Local sites" panels use PowerShell and IIS, and the other panels work anywhere.

## Setting it up

1. Copy `config.example.json` to `config.json` and fill it in. Every setting is described at the top of `server.js` (`DEFAULTS`). A panel whose settings are empty says "not set up" instead of failing, so you can start with just `ORG`, `ME`, `BACKLOG_PROJECT` and `BACKLOG_AREA`.
2. Replace the example rows in `backlog-data.js` with your own work items, or empty `N` and `E`. Open items without a row still show up; rows are only needed to draw dependencies.
3. Run `node server.js` and open http://localhost:8138.

To start it at logon instead, run `powershell -File install-startup-task.ps1` once. That registers a `dev-dashboard` scheduled task that runs `server.vbs`, which keeps `node server.js` running without a console window and restarts it 3 s after it exits. The task's second trigger is a watchdog that runs every 5 minutes and does nothing while the server is up.

Local files that should not be committed are listed in `.gitignore`: `config.json`, `.review-secret`, `dashboard.log`, and the JSON files that remember what the buttons sent.

## What it shows

| Panel | Source | Refresh |
|---|---|---|
| Milestones | `MILESTONES` in `backlog-data.js` | 5 min |
| Focus, open items, burndown, forecast, dependency graph | `/api/backlog`: every PBI and bug under `BACKLOG_AREA`, joined with the curated rows in `backlog-data.js` | 5 min |
| Completed PRs per week | `/api/throughput`: every PR completed in `THROUGHPUT_REPO` since `THROUGHPUT_FROM`. The team's PRs (into `WATCH_TARGET` or a feature branch built on it) are compared with everyone else's, and release PRs are stacked apart | 30 min |
| Pull requests | `/api/prs`: active PRs in `PR_SOURCES` that are yours, that you review, or that go into `WATCH_TARGET`, with their linked work items and open comment threads | 2 min |
| Since yesterday | The board, PRs, the design repo and the upstream branch, merged into one feed | with the others |
| Waiting on people | `/api/design`: a table of open questions in a markdown file (`DESIGN`). The parser expects one specific format, so adapt `parseQuestions` in `server.js` to yours or leave `DESIGN` empty | 10 min |
| Branch drift | `/api/drift`: what the branch your team branch syncs with has that yours lacks (`DRIFT`), by file content | 10 min |
| Worktrees | `/api/worktrees`: `git worktree list` of `REPO_ROOT`, with status, ahead/behind `BASES`, and the PR behind each branch | 2 min |
| Docker | `/api/docker`: `docker ps` and `stats` every 15 s, `system df` and `images` every 5 min | 15 s |
| Local sites, this machine | `/api/local`: an HTTPS probe of each of `SITES`, plus IIS worker processes, IIS Express, disks and the WSL VM | 20 s |

The **priority switch** in the header (P0, P1, P2, Untagged, All) sets what Focus, the open items, the burndown and the graph show. The priority is a `p0`, `p1` or `p2` tag on the board item.

Buttons that change something:

- **Start/Stop** on a container runs `docker start|stop <name>`, only for a name that `docker ps` listed.
- **Copy clean-up commands** copies `git worktree remove` lines for worktrees whose PR is completed or abandoned and that have no local changes. Nothing runs by itself.
- The **agent buttons** below.

The server only accepts POSTs from its own page: they need an `X-Dashboard` header and a localhost Host header.

## Agent buttons (optional, T3 Code)

These buttons hand work to coding-agent threads in T3 Code through its `t3` CLI (`T3_CLI`) and a webhook task. Without T3 Code set up, they don't show. The messages they send live in `server.js`, so you can adapt them to another agent tool and to how your team works.

- **Start review**, on someone else's PR that nobody reviewed yet, posts the PR's facts to a T3 Code webhook task (`REVIEW_WEBHOOK`), signed with HMAC-SHA256 using the secret in `.review-secret`. The review instructions live in the task's prompt, not in the request.
- **Re-check**, once every comment thread you started is resolved or answered, asks the review thread to verify the fixes and give a merge confidence score. At `APPROVE_SCORE` or higher it votes Approve, and that is the only thing it writes to the PR (`recheckPr`).
- **Fix comments**, on your own PR with comments waiting on you, sends the T3 thread linked to the PR a message to fix them, push, reply and resolve (`fixComments`).
- **Finish**, on your own approved PR, asks that thread to check the policies, squash-merge, build the result, set the work items to Done when their acceptance criteria are met, and clean up (`finishPr`).
- **Start work**, on an unassigned backlog item, starts a new thread in a new worktree from `WATCH_TARGET` that plans first, then builds and opens a draft PR (`startWork`).

Each one refuses a second send for the same item within a few minutes. The PR rows also show the merge confidence score that the review thread ended with ("Merge confidence: N/10").

## Notes

- **Logs:** failures go to `dashboard.log` next to the server.
- **After a code change:** stop the `node` process on port 8138. Under the scheduled task, `server.vbs` starts the new code 3 s later. The page and `backlog-data.js` are read on every request, so changes to them only need a browser reload.
- **Stopping it for good:** `Stop-ScheduledTask -TaskName dev-dashboard`, stop the `wscript.exe` running `server.vbs`, then the `node` on port 8138. `Unregister-ScheduledTask -TaskName dev-dashboard` removes the task.
