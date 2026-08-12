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
