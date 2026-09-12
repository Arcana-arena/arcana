.PHONY: migrate-up migrate-down migrate-create migrate-version migrate-force help

# Centralized DB migrations for the ARCANA monorepo.
# Uses golang-migrate CLI. Reads DATABASE_URL from ../../.env (repo root).

ENV_FILE := ../../.env
-include $(ENV_FILE)
export

MIGRATE := migrate
MIGRATIONS_DIR := ./migrations

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

migrate-up: ## Apply all pending migrations
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$$DATABASE_URL" up

migrate-down: ## Roll back the most recent migration (use N=count for more)
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$$DATABASE_URL" down $(if $(N),$(N),1)

migrate-create: ## Create a new migration pair: make migrate-create NAME=create_foo
	@test -n "$(NAME)" || (echo "Usage: make migrate-create NAME=<name>" && exit 1)
	$(MIGRATE) create -ext sql -dir $(MIGRATIONS_DIR) -seq "$(NAME)"

migrate-version: ## Show current migration version
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$$DATABASE_URL" version

migrate-force: ## Force schema version: make migrate-force VERSION=<n>
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$$DATABASE_URL" force $(VERSION)
