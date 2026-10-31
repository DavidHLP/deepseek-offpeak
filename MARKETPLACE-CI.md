# Marketplace feedback and CI coverage

Target: DavidHLP/deepseek-offpeak, marketplace omacom/omarchy-plugin-marketplace.
The paginated account submissions returned #6265 and #7740, both the same plugin;
no second candidate was found. Marketplace PRs, submission/update issues and their
complete comment lists were inspected. Human security findings are distinct from
bot structure/baseline reports; a bot pass did not resolve human blockers.

| Original feedback | Revision and disposition | Automation decision |
| --- | --- | --- |
| [Startup shell, unlimited key, request bytes/time/identity](https://github.com/omacom/omarchy-plugin-marketplace/issues/6265#issuecomment-5629790271) | 2c207d4; 53521a4 removed startup lookup and added bounds, but did not fully solve descendants | Existing balance tests cover key maximum/alphabet, request identity and limits, parser byte/cardinality/string ceilings and shared acquisition policy. No duplicate test added. |
| [Shell watchdog leaves curl descendant](https://github.com/omacom/omarchy-plugin-marketplace/issues/6265#issuecomment-5629838397) | 53521a4; 1547782 removed shell/pipeline, launches absolute curl directly | Existing request argv/spec assertions cover direct command construction. Actual Quickshell kill/recovery remains host runtime acceptance; a source regex is not proof of process termination. |
| [Predictable cache staging, symlink writes, pathname reopen/FIFO/oversized reads](https://github.com/omacom/omarchy-plugin-marketplace/issues/7740#issuecomment-5891455457) | a465856; PR #5 merged as d03d6a0 | Existing holiday tests cover guarded ancestors/ownership/permissions, mktemp staging and bounded producer specs. Added actual CLI reader fixtures for cache-file symlink, FIFO, exact byte ceiling and oversized input, including descriptor closure. |
| [Maintainer confirms cache findings resolved](https://github.com/omacom/omarchy-plugin-marketplace/issues/7740#issuecomment-5920987578) | d03d6a0; complete runtime reviewed remotely, repository code not executed by maintainer | Confirmation of the fix, not a new defect or runtime test result. |

The new test evaluates the actual CLI reader in a Node VM and uses temporary
files, a synthetic valid document, a symlink and a FIFO. Each invocation is a
bounded child, so a blocking regression fails within two seconds. It never
starts the CLI, reads credentials or makes a network request. This is a focused
filesystem regression test, not a full CLI or Quickshell runtime test.

Both `.github/workflows/ci.yml` (PR/main/manual) and `release.yml` (tag/manual)
already run `node tests/holidays.test.js`; CI `ci-ok` requires the Node job and
release publication requires validation. No workflow changes or extra job needed.

Validation: holidays 27, schedule 28 (TZ=UTC), balance 22, status 14; manifest,
host QML and diff whitespace pass. Removing O_NOFOLLOW makes the symlink case
fail; removing O_NONBLOCK makes the FIFO case time out and fail. Original CLI
restored after each mutation. No marketplace changes or publication performed.

Limits: existing pure/shared contract checks do not prove that QML consumers
continue to use the contracts, or prove actual desktop watchdog behavior. Such
changes still need review and host execution. Appearance/interaction and market
exact-commit publication remain manual/external, not deterministic offline CI.
History was accessible; older issue body prose contains superseded claims (for
example no cache writes), so current source and dated maintainer comments were
used instead of treating the current issue body as an immutable submission.
