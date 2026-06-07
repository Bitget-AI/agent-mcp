# Bitget Agent MCP - Spug EC2 publisher entry points.
#
# Spug invokes environment-specific target names from MakefileEc2.mk. The CD
# host package does not include the root Makefile, so these targets must be
# self-contained.

.PHONY: \
	build-bg-prod-data-prod-production-data-bitget-agent-mcp-external \
	start-bg-prod-data-prod-production-data-bitget-agent-mcp-external \
	healthcheck-bg-prod-data-prod-production-data-bitget-agent-mcp-external \
	stop-bg-prod-data-prod-production-data-bitget-agent-mcp-external

DIST_DIR := dist

build-bg-prod-data-prod-production-data-bitget-agent-mcp-external:
	rm -rf $(DIST_DIR) lib
	pnpm install --frozen-lockfile
	pnpm run build
	mkdir -p $(DIST_DIR)
	cp package.json README.md LICENSE CHANGELOG.md VERSION server.json $(DIST_DIR)/
	cp -R lib $(DIST_DIR)/
	rm -f .npmrc kms/.npmrc
	cd kms && pnpm install --frozen-lockfile && pnpm run build
	cp -R kms $(DIST_DIR)/
	test -f $(DIST_DIR)/package.json
	test -f $(DIST_DIR)/VERSION
	test -f $(DIST_DIR)/server.json
	test -d $(DIST_DIR)/lib
	test -f $(DIST_DIR)/lib/index.js
	test -d $(DIST_DIR)/kms
	test -f $(DIST_DIR)/kms/dist/index.js

start-bg-prod-data-prod-production-data-bitget-agent-mcp-external:
	set -eu; \
	publish_dir="."; \
	if [ ! -d "$$publish_dir/kms" ] && [ -d "$(DIST_DIR)/kms" ]; then publish_dir="$(DIST_DIR)"; fi; \
	if [ ! -d "$$publish_dir/kms" ]; then echo "kms directory missing in $$PWD and $(DIST_DIR)"; exit 1; fi; \
	cleanup() { rm -f "$$publish_dir/.npmrc" "$$publish_dir/kms/.npmrc"; }; \
	trap cleanup EXIT; \
	cleanup; \
	(cd "$$publish_dir/kms" && pnpm run kms-run); \
	if [ ! -s "$$publish_dir/kms/.npmrc" ]; then \
		echo "ERROR: kms-run did not produce a non-empty .npmrc"; exit 1; \
	fi; \
	cp "$$publish_dir/kms/.npmrc" "$$publish_dir/.npmrc"; \
	(cd "$$publish_dir" && npm publish --access public)

healthcheck-bg-prod-data-prod-production-data-bitget-agent-mcp-external:
	@echo "healthcheck-ok"

stop-bg-prod-data-prod-production-data-bitget-agent-mcp-external:
	rm -f .npmrc kms/.npmrc $(DIST_DIR)/.npmrc $(DIST_DIR)/kms/.npmrc
