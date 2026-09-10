module github.com/arcana/signer

go 1.23.4

require (
	github.com/arcana/internalauth v0.0.0
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.3.0
	github.com/jackc/pgx/v5 v5.7.1
	golang.org/x/crypto v0.31.0
)

replace github.com/arcana/internalauth => ../../packages/go-internalauth
