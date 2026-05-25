# Bedcoder (agent + relay) — top-level test / lint orchestration.
# Usage: make install && make test-all

.PHONY: install test-all test-protocol test-agent test-e2e test-relay lint lint-ts lint-go build-agent build-relay

install:
	pnpm install

# ---- tests ----
test-all: test-protocol test-agent test-relay test-e2e

test-protocol:
	cd protocol && pnpm test

test-agent:
	cd agent && pnpm test

test-e2e:
	cd e2e && pnpm test

test-relay:
	cd relay && go test ./...

# ---- build ----
build-agent:
	cd agent && pnpm build

build-relay:
	cd relay && CGO_ENABLED=0 go build -trimpath -o bedcoder-relay ./cmd/relay

# ---- lint ----
lint: lint-ts lint-go

lint-ts:
	pnpm -r lint
	pnpm -r typecheck

lint-go:
	cd relay && test -z "$$(gofmt -l .)" && go vet ./...
