# BSA Sentry. One command per thing.
SHELL := /bin/bash
DEVICE_IMAGE := ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest
APP := device-app/app

.PHONY: help test device speculos load clean-device

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

test: ## All TS tests + the device core Rust tests
	pnpm -r test
	cd device-app/core && cargo test

device: ## Build the Flex ELF in Ledger's Docker image
	scripts/device-build.sh

speculos: ## Run the app in Speculos (Flex model, headless, REST API on :5000)
	scripts/speculos.sh

load: ## Sideload on the REAL Flex. Phase C only: PIN on the device, dashboard, no other app talking to it.
	~/.venvs/ledger/bin/python -m ledgerblue.runScript \
		--elfFile $(APP)/target/flex/release/bsa-sentry \
		--fileName $(APP)/target/flex/release/bsa-sentry.apdu --apdu --scp

clean-device: ## Drop the device build cache
	rm -rf $(APP)/target
