# Task 2 report — tenant migration and isolation

Status: complete for the Task 2 scope.

## TDD evidence

- Initial RED: `tests/test_tenant_isolation.py` collected with **1 error**
  (`ModuleNotFoundError: jarvis.tenancy`) before implementation.
- GREEN: `tests/test_tenant_isolation.py -q` => **11 passed**.
- Focused regression: `pytest tests/test_{accounts,auth,threads,tenant_isolation,wechat,wechat_api,openai_api}.py tests/test_{new_tools,location,local_status}.py -q` => **96 passed** (one existing TestClient deprecation warning).
- Reverse proof: temporarily removed `owner_id` from the `TenantStore.get_thread` predicate; `test_same_alias_has_distinct_checkpoint_and_owner_only_delete` failed (**1 failed**) by returning the Owner checkpoint to the Member. The exact owner predicate was restored; focused suite is green.

## Implementation evidence

- `jarvis/tenancy.py` has versioned, owner-FK SQLite tables for threads, memos, todos, schedules, locations and local status. A `ContextVar` `tenant_scope` is mandatory; no-scope tool invocation raises `TenantScopeError`.
- New thread checkpoint IDs are server-generated and Owner-namespaced. Legacy Owner threads retain their raw checkpoint IDs.
- Web cookie/Desktop/OpenAI bearer resolve a `Principal`; aliases never carry an owner. History and delete test the owned alias first and return 404 for missing or foreign aliases.
- WeChat and CLI obtain the sole active Owner from `AccountStore`; multiple/no Owner fails closed. Existing WeChat tests exercise the namespaced reply checkpoint without any network transport.
- Old JSON data is read without modification; each present legacy file receives a same-directory 0600 `.tenant-v1.bak` before a single transaction imports it and records completion. Tests cover all listed files, a rollback injection, malformed JSON, idempotent retry, and a completed migration after a second Owner is added.

## Remaining concern

The pre-existing `BLOCKED.md` concerns optional external search credentials and is outside Task 2. No provider settings, production state, old data files, or WeChat credentials were changed.

## Review round 1 fixes

- TDD RED: the new review-targeted set initially had **4 failures**: empty legacy data was incorrectly marked complete, completed migration still read malformed input, a Member could read the WeChat bridge, and boot resumed a token without an Owner. A temporary two-Owner authorization mutation produced **1 additional RED failure** (HTTP 200 instead of 403). Both mutations were restored after the green implementation.
- WeChat HTTP routes now require that the current principal is the **unique** active Owner; Members and ambiguous two-Owner configurations receive 403 before bridge status/connect/disconnect is called. `resume_on_boot` resolves that same Owner before opening a token file, preserving credentials and leaving workers stopped when absent/ambiguous.
- `upsert_thread` now serializes its select/update-or-insert under `BEGIN IMMEDIATE`; a 32-way same-alias test returns one checkpoint with no integrity errors, while another owner gets a distinct namespace.
- Legacy migration first checks the completion marker, then only reads files when incomplete. An empty directory returns false without marker/Owner requirement; a later legacy file remains migratable. Completed migration ignores subsequently malformed originals.
- GREEN after the review fixes: `pytest tests/test_{accounts,auth,threads,tenant_isolation,wechat,wechat_api,openai_api}.py tests/test_{new_tools,location,local_status}.py -q` => **102 passed** (one existing TestClient deprecation warning); `git diff --check` passed.

## Review round 2 fix

- TDD RED: a backup hook created a second Owner after the preliminary lookup. The old implementation completed migration despite ambiguous ownership; the precise test failed because no `TenantMigrationError` was raised.
- The `BEGIN IMMEDIATE` import transaction now rechecks both the completion marker and the sole active Owner. It aborts and rolls back if the transaction Owner is absent, ambiguous, or differs from the pre-backup candidate; backups may remain, but no tenant rows or completion marker are written.
- GREEN: the migration race/rollback target tests passed (**3 passed**), and the Task 2 focused suite passed **103 tests** (one existing TestClient deprecation warning). `git diff --check` passed.
- The review's WeChat route/boot TOCTOU observation remains a documented follow-up; it would require a broader account/bridge synchronization contract and is intentionally not changed in this narrow round.
