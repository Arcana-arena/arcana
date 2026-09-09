module github.com/arcana/scoring-engine

go 1.23.4

require github.com/jackc/pgx/v5 v5.7.1

require github.com/arcana/internalauth v0.0.0

replace github.com/arcana/internalauth => ../../packages/go-internalauth
