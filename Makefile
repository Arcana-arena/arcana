.PHONY: help test-go build-go

# Go builds and tests for the ARCANA workspace.
#
# WHY THESE TARGETS EXIST, rather than leaving people to type `go test ./...`:
#
#  1. `go build ./...` and `go test ./...` DO NOT WORK from this directory. The
#     repo root is not a module — go.work lists five, and none of them is here —
#     so the wildcard matches nothing and Go says:
#
#         pattern ./...: directory prefix . does not contain modules
#         listed in go.work or their selected dependencies
#
#     which reads like a broken checkout and is not one. These targets walk the
#     modules go.work actually lists.
#
#  2. `go test` DISCARDS ALL OUTPUT OF A PASSING PACKAGE — stdout and stderr,
#     printed before or after m.Run(), established here by experiment rather than
#     assumed. So a package whose every DB-backed test skipped still prints a
#     bare `ok`, and NOTHING printed from inside the test binary can correct it.
#     That is why test-go runs the tests verbosely into a log and summarises the
#     log itself: a skip count belongs in the summary, and this is the only place
#     it can be put.
#
#  3. The DB-backed tests need DATABASE_URL, which lives in the repo-root .env —
#     the same file packages/db-migrations/Makefile reads. A run without it used
#     to print `ok` over six tests that never executed. Those now FAIL rather
#     than skip wherever Postgres is reachable (see
#     services/decision-engine/internal/store/db_required_test.go), and the fix
#     for that failure should be a documented command, so here it is.
#
# The module list comes from go.work rather than being kept here, so a module
# added to the workspace cannot quietly drop out of the test run.

SHELL := /bin/bash
LOG_DIR := .test-logs
ENV_FILE := .env
-include $(ENV_FILE)
export

GO_MODULES := $(shell go work edit -json | sed -n 's/.*"DiskPath": "\(.*\)".*/\1/p')

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

test-go: ## Run every Go test in the workspace, with DATABASE_URL from .env
	@test -f $(ENV_FILE) || echo "note: no $(ENV_FILE) here, so DATABASE_URL is unset; DB-backed tests will FAIL where Postgres is reachable and skip where it is not"
	@mkdir -p $(LOG_DIR)
	@fail=0; tp=0; tf=0; ts=0; \
	for m in $(GO_MODULES); do \
		log=$(LOG_DIR)/$$(echo "$$m" | tr '/.' '__').log; \
		( cd "$$m" && go test -count=1 -v ./... ) > "$$log" 2>&1 || fail=1; \
		p=$$(grep -c '^--- PASS' "$$log"); f=$$(grep -c '^--- FAIL' "$$log"); s=$$(grep -c '^--- SKIP' "$$log"); \
		tp=$$((tp+p)); tf=$$((tf+f)); ts=$$((ts+s)); \
		printf '%-32s %3d passed  %3d failed  %3d skipped\n' "$$m" "$$p" "$$f" "$$s"; \
		grep -E '^--- (FAIL|SKIP)' "$$log" | sed 's/^/      /'; \
		if grep -q 'SKIPPED, not passed' "$$log"; then \
			echo "      ^ these did not run at all, which is NOT a pass. Full log: $$log"; \
		fi; \
		if [ "$$f" -gt 0 ]; then \
			awk '/^[ \t]+/ {buf = buf $$0 "\n"; next} /^--- FAIL/ {printf "%s", buf; exit} {buf = ""}' "$$log" | head -8 | sed 's/^/      /'; \
			echo "      full output: $$log"; \
		fi; \
	done; \
	echo "----"; \
	printf 'total: %d passed, %d failed, %d skipped\n' "$$tp" "$$tf" "$$ts"; \
	if [ "$$ts" -gt 0 ]; then echo "WARNING: $$ts test(s) did not run. A skip is not a pass."; fi; \
	exit $$fail

build-go: ## Build every Go module in the workspace
	@fail=0; for m in $(GO_MODULES); do \
		echo "=== build $$m ==="; \
		( cd "$$m" && go build ./... ) || fail=1; \
	done; exit $$fail
